const express = require('express');
const fs = require('fs');

let chromium;
try {
  const playwrightExtra = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth');
  playwrightExtra.chromium.use(stealth());
  chromium = playwrightExtra.chromium;
} catch {
  ({ chromium } = require('playwright'));
}

const CHROME_EXECUTABLES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/local/bin/google-chrome',
  '/opt/google/chrome/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const PORT = readPositiveInt('PORT', 3004);
const TARGET_URL = 'https://xcellparts.com/';
const TEST_CATEGORY_URL = 'https://xcellparts.com/product-category/apple/iphone/iphone-17e-iphone/';
const MAX_PAGES = readPositiveInt('MAX_XCP_PAGES', 100);
const CLOUDFLARE_RETRIES = readPositiveInt('CLOUDFLARE_RETRIES', 6);
const CLOUDFLARE_WAIT_MS = readPositiveInt('CLOUDFLARE_WAIT_MS', 5000);
const HEADLESS = readBoolean('HEADLESS', true);
const USER_AGENT =
  process.env.CHROME_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const CATEGORY_LINK_SELECTOR = [
  'header a[href*="/product-category/"]',
  'nav a[href*="/product-category/"]',
  '.mega-menu a[href*="/product-category/"]',
  '.menu a[href*="/product-category/"]',
  '.elementor-nav-menu a[href*="/product-category/"]',
  'footer a[href*="/product-category/"]',
  'a[href*="/product-category/"]',
].join(', ');

const PRODUCT_CARD_SELECTOR = [
  'ul.products li.product',
  '.woocommerce ul.products li.product',
  '.products .product',
  'li.product',
].join(', ');

const PRODUCT_LIST_READY_SELECTOR = [
  PRODUCT_CARD_SELECTOR,
  '.woocommerce-result-count',
  '.woocommerce-pagination',
  '.woocommerce-info',
  '.woocommerce-no-products-found',
  '.products',
].join(', ');

const app = express();

function readInteger(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || `${defaultValue}`, 10);
  return Number.isFinite(value) ? value : defaultValue;
}

function readPositiveInt(name, defaultValue) {
  return Math.max(1, readInteger(name, defaultValue));
}

function readBoolean(name, defaultValue) {
  if (!(name in process.env)) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(`${process.env[name]}`.toLowerCase());
}

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found or not executable, try next
    }
  }

  throw new Error(
    'Google Chrome executable not found. Install Google Chrome or set the CHROME_PATH environment variable.'
  );
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value) {
  if (!value) {
    return '';
  }

  const url = new URL(value, TARGET_URL);
  url.hash = '';
  return url.toString();
}

function buildPageUrl(categoryUrl, pageNumber) {
  const url = new URL(categoryUrl);
  url.pathname = url.pathname.replace(/\/page\/\d+\/?$/i, '/');

  if (pageNumber <= 1) {
    return url.toString();
  }

  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${pathname}page/${pageNumber}/`;
  return url.toString();
}

function getProductKey(product) {
  return product.product_url || [product.name, product.sku, product.price].join('|');
}

async function newBrowserPage() {
  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    executablePath,
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080',
    ],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  return { executablePath, browser, page };
}

async function getPageDiagnostics(page) {
  return page.evaluate((cardSelector) => {
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    const bodyText = normalize(document.body?.innerText).slice(0, 800);

    return {
      finalUrl: window.location.href,
      title: normalize(document.title),
      h1: normalize(document.querySelector('h1')?.textContent),
      productCardCount: document.querySelectorAll(cardSelector).length,
      resultCount: normalize(document.querySelector('.woocommerce-result-count')?.textContent),
      emptyMessage: normalize(
        document.querySelector('.woocommerce-info, .woocommerce-no-products-found')?.textContent
      ),
      bodyText,
      cloudflare:
        /just a moment|security verification|cloudflare|enable javascript and cookies/i.test(
          `${document.title} ${bodyText}`
        ),
    };
  }, PRODUCT_CARD_SELECTOR);
}

async function waitForCloudflare(page) {
  for (let attempt = 0; attempt <= CLOUDFLARE_RETRIES; attempt++) {
    const diagnostics = await getPageDiagnostics(page).catch(() => null);

    if (!diagnostics?.cloudflare) {
      return diagnostics;
    }

    if (attempt === CLOUDFLARE_RETRIES) {
      throw new Error(
        `XCellParts Cloudflare challenge is still active after ${CLOUDFLARE_RETRIES} retries. ` +
        `Try running with HEADLESS=false or wait and retry. Last title: ${diagnostics.title}`
      );
    }

    await page.waitForTimeout(CLOUDFLARE_WAIT_MS);
  }

  return null;
}

async function waitForReadyPage(page, selector) {
  await waitForCloudflare(page);

  try {
    await page.waitForSelector(selector, { state: 'attached', timeout: 30000 });
  } catch {
    const diagnostics = await getPageDiagnostics(page).catch(() => null);
    console.warn('[serverxcp] Page did not reach expected selector:', diagnostics);
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function scrapeCategories() {
  const { executablePath, browser, page } = await newBrowserPage();

  try {
    await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await waitForReadyPage(page, CATEGORY_LINK_SELECTOR);

    const categories = await page.evaluate((linkSelector) => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const skippedTexts = new Set(['apple_menu', 'samsung_menu', 'moto_menu', 'lg_menu']);
      const seen = new Set();
      const results = [];

      document.querySelectorAll(linkSelector).forEach(link => {
        const text = normalize(link.textContent || link.getAttribute('aria-label') || link.getAttribute('title'));
        const href = link.href;

        if (
          !text ||
          skippedTexts.has(text.toLowerCase()) ||
          !href ||
          !href.includes('/product-category/') ||
          href.startsWith('javascript:') ||
          seen.has(href)
        ) {
          return;
        }

        seen.add(href);
        results.push({ text, url: href });
      });

      return results;
    }, CATEGORY_LINK_SELECTOR);

    return { executablePath, categories };
  } finally {
    await browser.close();
  }
}

async function getPageStats(page) {
  return page.evaluate(() => {
    const toNumber = value => {
      const match = `${value || ''}`.replace(/,/g, '').match(/\d+/);
      return match ? Number.parseInt(match[0], 10) : null;
    };

    const resultText = document.querySelector('.woocommerce-result-count')?.textContent || '';
    const totalMatch = resultText.replace(/,/g, '').match(/of\s+(\d+)\s+results?/i);
    const expectedTotal = totalMatch ? Number.parseInt(totalMatch[1], 10) : toNumber(resultText);

    const pageNumbers = Array.from(document.querySelectorAll('.woocommerce-pagination .page-numbers'))
      .map(el => toNumber(el.textContent))
      .filter(Number.isFinite);

    const nextPageUrl =
      document.querySelector('.woocommerce-pagination a.next.page-numbers')?.href ||
      document.querySelector('a.next.page-numbers')?.href ||
      '';

    return {
      expectedTotal,
      totalPages: pageNumbers.length ? Math.max(...pageNumbers) : 1,
      nextPageUrl,
    };
  });
}

async function collectVisibleProducts(page) {
  return page.evaluate((cardSelector) => {
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    const cleanImage = img => {
      if (!img) return '';
      const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset') || '';
      const firstSrcsetUrl = srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';

      return (
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('src') ||
        firstSrcsetUrl ||
        ''
      );
    };

    return Array.from(document.querySelectorAll(cardSelector))
      .map(card => {
        const nameEl =
          card.querySelector('.woocommerce-loop-product__title') ||
          card.querySelector('.product-title') ||
          card.querySelector('.product-name') ||
          card.querySelector('h2, h3');

        const linkEl =
          card.querySelector('a.woocommerce-LoopProduct-link[href]') ||
          nameEl?.closest('a[href]') ||
          card.querySelector('a[href*="/product/"]') ||
          card.querySelector('a[href]');

        const imgEl =
          card.querySelector('img.attachment-woocommerce_thumbnail') ||
          card.querySelector('.woocommerce-LoopProduct-link img') ||
          card.querySelector('img');

        const priceEl =
          card.querySelector('.price ins .amount') ||
          card.querySelector('.price .amount') ||
          card.querySelector('.price');

        const addToCartEl =
          card.querySelector('[data-product_id]') ||
          card.querySelector('[data-product_sku]') ||
          card.querySelector('a.add_to_cart_button');

        const productUrl = linkEl?.href || '';
        const name = normalize(
          nameEl?.textContent ||
          linkEl?.getAttribute('aria-label') ||
          imgEl?.getAttribute('alt') ||
          linkEl?.getAttribute('title')
        );
        const sku =
          normalize(addToCartEl?.getAttribute('data-product_sku')) ||
          normalize(card.getAttribute('data-product_sku')) ||
          normalize(card.querySelector('[data-product_sku]')?.getAttribute('data-product_sku')) ||
          '';

        return {
          name,
          product_url: productUrl,
          image: cleanImage(imgEl),
          price: normalize(priceEl?.textContent),
          sku,
          product_id: addToCartEl?.getAttribute('data-product_id') || '',
          in_stock: !/out of stock|read more|sold out/i.test(normalize(card.textContent)),
        };
      })
      .filter(product => product.name && product.product_url);
  }, PRODUCT_CARD_SELECTOR);
}

async function scrapeProducts(categoryUrl) {
  const { executablePath, browser, page } = await newBrowserPage();
  const seenProducts = new Map();
  const visitedPages = new Set();
  let expectedTotal = null;
  let totalPages = 1;
  let nextPageUrl = buildPageUrl(categoryUrl, 1);
  let diagnostics = null;

  try {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES && nextPageUrl; pageNumber++) {
      const pageUrl = normalizeUrl(nextPageUrl);

      if (visitedPages.has(pageUrl)) {
        break;
      }

      visitedPages.add(pageUrl);
      console.log(`[serverxcp] Opening ${pageUrl}`);

      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await waitForReadyPage(page, PRODUCT_LIST_READY_SELECTOR);

      const stats = await getPageStats(page);
      expectedTotal = stats.expectedTotal ?? expectedTotal;
      totalPages = Math.max(totalPages, stats.totalPages || 1);

      const products = await collectVisibleProducts(page);
      products.forEach(product => {
        const key = getProductKey(product);
        if (key && !seenProducts.has(key)) {
          seenProducts.set(key, product);
        }
      });

      console.log(
        `[serverxcp] Page ${pageNumber}/${totalPages}: collected ${products.length}, total ${seenProducts.size}/${expectedTotal ?? '?'}`
      );

      if (expectedTotal !== null && seenProducts.size >= expectedTotal) {
        break;
      }

      if (stats.nextPageUrl) {
        nextPageUrl = stats.nextPageUrl;
      } else if (pageNumber < totalPages) {
        nextPageUrl = buildPageUrl(categoryUrl, pageNumber + 1);
      } else {
        nextPageUrl = '';
      }

      if (products.length === 0) {
        diagnostics = await getPageDiagnostics(page).catch(() => null);
        console.warn('[serverxcp] No products collected on page:', diagnostics);
        break;
      }
    }

    if (seenProducts.size === 0) {
      diagnostics = diagnostics || await getPageDiagnostics(page).catch(() => null);
    }

    return {
      executablePath,
      expectedTotal,
      totalPages,
      pagesVisited: visitedPages.size,
      diagnostics,
      products: Array.from(seenProducts.values()),
    };
  } finally {
    await browser.close();
  }
}

app.get('/', (request, response) => {
  response.json({
    status: 'running',
    openUrl: `http://localhost:${PORT}/getCategory`,
    productTestUrl: `http://localhost:${PORT}/getProduct?url=${encodeURIComponent(TEST_CATEGORY_URL)}`,
  });
});

app.get('/getCategory', async (request, response) => {
  try {
    const { executablePath, categories } = await scrapeCategories();

    response.json({
      success: true,
      url: TARGET_URL,
      browser: executablePath,
      count: categories.length,
      categories,
    });
  } catch (error) {
    response.status(500).json({
      success: false,
      url: TARGET_URL,
      error: error.message,
    });
  }
});

app.get('/getProduct', async (request, response) => {
  const categoryUrl = request.query.url;

  if (!categoryUrl) {
    return response.status(400).json({
      success: false,
      error: 'Missing required query parameter: url',
      example: `/getProduct?url=${TEST_CATEGORY_URL}`,
    });
  }

  try {
    const { executablePath, expectedTotal, totalPages, pagesVisited, diagnostics, products } =
      await scrapeProducts(categoryUrl);

    response.json({
      success: true,
      url: categoryUrl,
      browser: executablePath,
      expectedTotal,
      totalPages,
      pagesVisited,
      diagnostics,
      count: products.length,
      products,
    });
  } catch (error) {
    response.status(500).json({
      success: false,
      url: categoryUrl,
      error: error.message,
    });
  }
});

const server = app
  .listen(PORT, () => {
    console.log(`XCellParts server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/getCategory to launch ${TARGET_URL} in Chrome.`);
    console.log(`Test products at http://localhost:${PORT}/getProduct?url=${TEST_CATEGORY_URL}`);
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error('Stop the existing server or run with another port, for example: PORT=3008 node serverxcp.js');
      process.exit(1);
    }

    throw error;
  });

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

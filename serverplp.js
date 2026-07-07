const express = require('express');
const fs = require('fs');
const { chromium } = require('playwright');

// Possible Google Chrome executable paths on Linux / Mac / Windows
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

const PORT = readPositiveInt('PORT', 3002);
const TARGET_URL = 'https://www.phonelcdparts.com/';
const TEST_CATEGORY_URL = 'https://www.phonelcdparts.com/apple/iphone-parts/iphone-17-pro';
const MAX_PAGES = readPositiveInt('MAX_PLP_PAGES', 100);
const PRODUCT_CARD_SELECTOR = 'form.product-item, .item.product.product-item, li.item.product';
const PRODUCT_LIST_READY_SELECTOR = [
  PRODUCT_CARD_SELECTOR,
  '.products-grid',
  '.products.wrapper',
  '.products.list.items.product-items',
  '.message.info.empty',
  '.message.notice',
  '.page.messages',
].join(', ');
const USER_AGENT =
  process.env.CHROME_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const app = express();

function readPositiveInt(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || `${defaultValue}`, 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
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

function buildPageUrl(categoryUrl, pageNumber) {
  const url = new URL(categoryUrl);
  if (pageNumber > 1) {
    url.searchParams.set('p', `${pageNumber}`);
  } else {
    url.searchParams.delete('p');
  }
  return url.toString();
}

async function newBrowserPage() {
  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });

  const page = await context.newPage();
  return { executablePath, browser, page };
}

async function scrapeCategories() {
  const { executablePath, browser, page } = await newBrowserPage();

  try {
    await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // PhoneLCDParts injects the desktop/mobile Ninja Menu with an AJAX POST after DOMContentLoaded.
    await page.waitForSelector('.ninjamenus a[href], .swp-ninjamenudesk a[href], .swp-ninjamenu a[href]', {
      timeout: 30000,
    });

    await page.waitForTimeout(1000);

    const categories = await page.evaluate(() => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const seen = new Set();
      const results = [];
      const links = document.querySelectorAll(
        '.ninjamenus .nav-item a[href], .swp-ninjamenudesk a[href], .swp-ninjamenu a[href]'
      );

      links.forEach(link => {
        const href = link.href;
        const text = normalize(
          (link.querySelector('.title') || link).textContent
        );

        if (
          !text ||
          !href ||
          href.startsWith('javascript:') ||
          href.includes('#') ||
          !href.startsWith('https://www.phonelcdparts.com/') ||
          seen.has(href)
        ) {
          return;
        }

        seen.add(href);
        results.push({ text, url: href });
      });

      return results;
    });

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

    const toolbarNumbers = Array.from(document.querySelectorAll('.toolbar-number'))
      .map(el => toNumber(el.textContent))
      .filter(Number.isFinite);

    const expectedTotal = toolbarNumbers.length ? toolbarNumbers[toolbarNumbers.length - 1] : null;

    const pageCountFromAmasty = toNumber(document.querySelector('#am-page-count')?.textContent);
    const pageNumbers = Array.from(document.querySelectorAll('.pages a.page, .pages .page'))
      .map(el => toNumber(el.textContent))
      .filter(Number.isFinite);

    const pageSize =
      toolbarNumbers.length >= 2 && toolbarNumbers[1] >= toolbarNumbers[0]
        ? toolbarNumbers[1] - toolbarNumbers[0] + 1
        : null;

    const totalPages =
      pageCountFromAmasty ||
      (pageNumbers.length ? Math.max(...pageNumbers) : null) ||
      (expectedTotal && pageSize ? Math.ceil(expectedTotal / pageSize) : 1);

    return { expectedTotal, totalPages: Math.max(1, totalPages || 1) };
  });
}

async function getPageDiagnostics(page) {
  return page.evaluate((cardSelector) => {
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    const title = normalize(document.title);
    const h1 = normalize(document.querySelector('h1')?.textContent);
    const emptyMessage = normalize(
      document.querySelector('.message.info.empty, .message.notice, .page.messages')?.textContent
    );
    const bodyText = normalize(document.body?.innerText).slice(0, 500);

    return {
      finalUrl: window.location.href,
      title,
      h1,
      emptyMessage,
      productCardCount: document.querySelectorAll(cardSelector).length,
      bodyText,
    };
  }, PRODUCT_CARD_SELECTOR);
}

async function waitForProductList(page) {
  try {
    await page.waitForSelector(PRODUCT_LIST_READY_SELECTOR, {
      state: 'attached',
      timeout: 30000,
    });
  } catch {
    const diagnostics = await getPageDiagnostics(page).catch(() => null);
    console.warn('[scrapeProducts] Product list did not become ready:', diagnostics);
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function collectVisibleProducts(page) {
  return page.evaluate((cardSelector) => {
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    const cleanSku = value => normalize(value).replace(/^SKU:\s*/i, '');
    const cleanImage = img => {
      if (!img) return '';
      const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset') || '';
      const firstSrcsetUrl = srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
      return (
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('src') ||
        firstSrcsetUrl ||
        ''
      );
    };

    return Array.from(document.querySelectorAll(cardSelector))
      .map(card => {
        const nameEl =
          card.querySelector('.product-item-link') ||
          card.querySelector('.product-item-name a') ||
          card.querySelector('a[title][href]');
        const productUrl =
          nameEl?.href ||
          card.querySelector('.product-item-photo[href]')?.href ||
          card.querySelector('a[href]')?.href ||
          '';

        const imageEl =
          card.querySelector('.product-image-photo') ||
          card.querySelector('.product-item-photo img') ||
          card.querySelector('img[alt]');

        const priceEl =
          card.querySelector('.price-wrapper .price') ||
          card.querySelector('.price-box .price') ||
          card.querySelector('.price');

        const loginPriceEl = Array.from(card.querySelectorAll('button, a, div, span'))
          .find(el => normalize(el.textContent).toLowerCase() === 'login to see price');

        const productId =
          card.querySelector('input[name="product"]')?.value ||
          (card.getAttribute('action') || '').match(/\/product\/(\d+)/)?.[1] ||
          '';

        const name = normalize(nameEl?.textContent || nameEl?.getAttribute('title'));
        const sku =
          cleanSku(card.getAttribute('data-sku')) ||
          cleanSku(card.querySelector('[data-sku]')?.getAttribute('data-sku')) ||
          cleanSku(card.querySelector('.product-sku')?.textContent) ||
          (productUrl ? decodeURIComponent(productUrl.split('/').filter(Boolean).pop()) : '');

        return {
          name,
          product_url: productUrl,
          image: cleanImage(imageEl),
          price: normalize(priceEl?.textContent) || normalize(loginPriceEl?.textContent),
          sku,
          product_id: productId,
          in_stock: !/out of stock|notify me/i.test(normalize(card.textContent)),
        };
      })
      .filter(product => product.name && product.product_url);
  }, PRODUCT_CARD_SELECTOR);
}

async function scrapeProducts(categoryUrl) {
  const { executablePath, browser, page } = await newBrowserPage();
  const seen = new Map();
  let expectedTotal = null;
  let totalPages = 1;

  try {
    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, MAX_PAGES); pageNumber++) {
      const pageUrl = buildPageUrl(categoryUrl, pageNumber);
      console.log(`[scrapeProducts] Opening ${pageUrl}`);

      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await waitForProductList(page);
      await page.waitForTimeout(1000);

      const stats = await getPageStats(page);
      expectedTotal = stats.expectedTotal ?? expectedTotal;
      totalPages = Math.max(totalPages, stats.totalPages || 1);

      const products = await collectVisibleProducts(page);
      products.forEach(product => {
        if (!seen.has(product.product_url)) {
          seen.set(product.product_url, product);
        }
      });

      console.log(
        `[scrapeProducts] Page ${pageNumber}/${totalPages}: collected ${products.length}, total ${seen.size}/${expectedTotal ?? '?'}`
      );

      if (expectedTotal !== null && seen.size >= expectedTotal) {
        break;
      }

      if (products.length === 0) {
        const diagnostics = await getPageDiagnostics(page);
        console.warn('[scrapeProducts] No products collected on page:', diagnostics);
        break;
      }
    }

    const diagnostics = seen.size === 0 ? await getPageDiagnostics(page) : null;

    return {
      executablePath,
      expectedTotal,
      totalPages,
      diagnostics,
      products: Array.from(seen.values()),
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
    const { executablePath, expectedTotal, totalPages, diagnostics, products } = await scrapeProducts(categoryUrl);

    response.json({
      success: true,
      url: categoryUrl,
      browser: executablePath,
      expectedTotal,
      totalPages,
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
    console.log(`PhoneLCDParts server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/getCategory to launch ${TARGET_URL} in Chrome.`);
    console.log(`Test products at http://localhost:${PORT}/getProduct?url=${TEST_CATEGORY_URL}`);
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error('Stop the existing server or run with another port, for example: PORT=3006 node serverplp.js');
      process.exit(1);
    }

    throw error;
  });

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const PORT = readPositiveInt('PORT', 3001);
const TARGET_URL = 'https://www.mobilesentrix.com/';
const ALLOWED_HOSTS = new Set(['mobilesentrix.com', 'www.mobilesentrix.com']);

const PRODUCT_ITEM_SELECTOR = 'li.item, .products-grid .item, .product-item';
const PRODUCT_DETAIL_READY_SELECTORS = [
  '[itemprop="sku"]',
  '.product-info-stock-sku .value',
  '.product.attribute.sku .value',
  '.sku .value',
  '.sku',
  '#product_tabs_description_tabbed_contents',
  '#description',
  '#product_tabs_description_contents',
  '.product.attribute.description .value',
  '.product-collateral .description',
  '.short-description',
  '.product-description',
  '[itemprop="description"]',
  'script[type="application/ld+json"]',
];
const CATEGORY_MENU_LINK_SELECTORS = [
  '.mob-desk-menu > li > a',
  '.nav-primary > li > a',
  '.navigation .level0 > a',
  '#nav > li > a',
  '.mob-desk-menu a[href]',
  '.nav-primary a[href]',
  '.navigation a[href]',
  '#nav a[href]',
];

const DESKTOP_USER_AGENT =
  process.env.CHROME_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const config = {
  maxConcurrentPages: readPositiveInt('MAX_CONCURRENT_PAGES', 6),
  detailConcurrency: readPositiveInt('DETAIL_CONCURRENCY', readPositiveInt('MAX_CONCURRENT_PAGES', 6)),
  requestTimeout: readPositiveInt('REQUEST_TIMEOUT', 45000),
  productDetailTimeout: readPositiveInt('PRODUCT_DETAIL_TIMEOUT', 15000),
  retryCount: Math.max(0, readInteger('RETRY_COUNT', 1)),
  headless: readBoolean('HEADLESS', true),
  maxProductPages: readPositiveInt('MAX_PRODUCT_PAGES', 1),
  scrapeDetails: readBoolean('SCRAPE_DETAILS', true),
  blockImages: readBoolean('BLOCK_IMAGES', true),
  blockStylesheets: readBoolean('BLOCK_STYLESHEETS', false),
  cloudflareRetries: readPositiveInt('CLOUDFLARE_RETRIES', 3),
  cloudflareWaitMs: readPositiveInt('CLOUDFLARE_WAIT_MS', 3000),
  locale: process.env.PLAYWRIGHT_LOCALE || 'en-US',
  timezoneId: process.env.PLAYWRIGHT_TIMEZONE || 'America/New_York',
  userDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR || path.join(__dirname, '.ms-playwright-profile'),
  detailCacheTtlMs: readPositiveInt('DETAIL_CACHE_TTL_MINUTES', 720) * 60 * 1000,
  maxCacheItems: readPositiveInt('DETAIL_CACHE_MAX_ITEMS', 10000),
};

const app = express();
const detailCache = new Map();
let pagePool = null;
let pagePoolStartPromise = null;

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

function readQueryBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(`${value}`.toLowerCase());
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function extractImgFromAttr(value) {
  if (!value) {
    return '';
  }

  return value.split(',')[0].trim().split(' ')[0].trim();
}

function getProductKey(product) {
  return product.product_url || [product.name, product.price, product.img].join('|');
}

function buildProductPageUrl(url, pageNumber) {
  if (pageNumber <= 1) {
    return url;
  }

  const parsedUrl = new URL(url);
  parsedUrl.searchParams.set('p', `${pageNumber}`);
  return parsedUrl.toString();
}

function isoSeconds(date) {
  return date.toISOString().slice(0, 19);
}

function getLimitedPositiveInt(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(value || `${defaultValue}`, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }

  return Math.min(parsed, maxValue);
}

function validateTargetUrl(input) {
  let parsedUrl;

  try {
    parsedUrl = new URL(input);
  } catch (error) {
    throw new Error('Invalid URL parameter.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed.');
  }

  if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
    throw new Error('Only MobileSentrix category/product URLs are allowed.');
  }

  return parsedUrl.toString();
}

function createLaunchOptions() {
  const launchOptions = {
    headless: config.headless,
    userAgent: DESKTOP_USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: config.locale,
    timezoneId: config.timezoneId,
    javaScriptEnabled: true,
    bypassCSP: false,
    extraHTTPHeaders: {
      'Accept-Language': `${config.locale},en;q=0.9`,
    },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080',
    ],
  };

  if (process.env.CHROME_PATH) {
    launchOptions.executablePath = process.env.CHROME_PATH;
  }

  return launchOptions;
}

async function configureContext(context) {
  context.setDefaultTimeout(config.requestTimeout);
  context.setDefaultNavigationTimeout(config.requestTimeout);

  await context.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();

    if (config.blockImages && ['image', 'font', 'media'].includes(resourceType)) {
      return route.abort();
    }

    if (config.blockStylesheets && resourceType === 'stylesheet') {
      return route.abort();
    }

    return route.continue();
  });
}

class PersistentPagePool {
  constructor(pageCount) {
    this.pageCount = pageCount;
    this.context = null;
    this.availablePages = [];
    this.createdPages = 0;
    this.waiters = [];
    this.closed = false;
  }

  async start() {
    if (this.context) {
      return;
    }

    this.context = await chromium.launchPersistentContext(config.userDataDir, createLaunchOptions());
    await configureContext(this.context);
  }

  async acquire() {
    if (this.closed) {
      throw new Error('Page pool is already closed.');
    }

    const page = this.availablePages.pop();
    if (page && !page.isClosed()) {
      return page;
    }

    if (this.createdPages < this.pageCount) {
      this.createdPages++;
      const newPage = await this.context.newPage();
      newPage.setDefaultTimeout(config.requestTimeout);
      newPage.setDefaultNavigationTimeout(config.requestTimeout);
      return newPage;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async release(page) {
    if (!page || page.isClosed()) {
      this.createdPages = Math.max(0, this.createdPages - 1);
      this.releaseWaiter(null);
      return;
    }

    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(page);
      return;
    }

    this.availablePages.push(page);
  }

  releaseWaiter(page) {
    const waiter = this.waiters.shift();
    if (waiter && page) {
      waiter(page);
    }
  }

  async close() {
    this.closed = true;
    await this.context?.close().catch((error) => {
      console.error(`Playwright context close failed: ${error.message}`);
    });
  }
}

async function getPagePool() {
  if (pagePool && pagePool.context && !pagePool.closed) {
    return pagePool;
  }

  if (!pagePoolStartPromise) {
    pagePool = new PersistentPagePool(config.maxConcurrentPages);
    pagePoolStartPromise = pagePool.start().finally(() => {
      pagePoolStartPromise = null;
    });
  }

  await pagePoolStartPromise;
  return pagePool;
}

async function gotoPage(page, url, waitUntil = 'domcontentloaded') {
  await page.goto(url, {
    waitUntil,
    timeout: config.requestTimeout,
  });
  await page.waitForSelector('body', { state: 'attached', timeout: config.requestTimeout }).catch(() => {});
}

async function getPageDebugInfo(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: window.location.href,
    bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  }));
}

function isCloudflareChallenge(debugInfo) {
  const text = `${debugInfo.title || ''} ${debugInfo.bodyText || ''}`.toLowerCase();

  return (
    text.includes('just a moment') ||
    text.includes('performing security verification') ||
    text.includes('verifies you are not a bot') ||
    text.includes('performance and security by cloudflare') ||
    text.includes('checking your browser')
  );
}

async function gotoPageWithCloudflareCheck(page, url) {
  let lastDebugInfo = null;

  for (let attempt = 1; attempt <= config.cloudflareRetries; attempt++) {
    await gotoPage(page, url);
    await page.waitForTimeout(attempt === 1 ? 500 : config.cloudflareWaitMs);

    lastDebugInfo = await getPageDebugInfo(page);
    if (!isCloudflareChallenge(lastDebugInfo)) {
      return;
    }

    console.error(`Cloudflare verification page detected for ${url}. Attempt ${attempt}/${config.cloudflareRetries}.`);
    await page.waitForTimeout(config.cloudflareWaitMs * attempt);
  }

  const hint = config.headless
    ? 'Run once with HEADLESS=false and complete the verification manually. The persistent profile will reuse that valid session after that.'
    : 'Complete the verification in the opened browser window, then retry the request.';

  throw new Error(
    `Cloudflare verification did not clear. ${hint} title="${lastDebugInfo?.title || ''}" url="${lastDebugInfo?.url || url}"`
  );
}

async function waitForCategoryMenu(page, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of CATEGORY_MENU_LINK_SELECTORS) {
      const count = await page.locator(selector).count().catch(() => 0);

      if (count > 0) {
        return selector;
      }
    }

    await page.waitForTimeout(250);
  }

  const debugInfo = await getPageDebugInfo(page);

  throw new Error(
    `Category menu was not found. title="${debugInfo.title}" url="${debugInfo.url}" body="${debugInfo.bodyText}"`
  );
}

async function autoScrollUntilStable(page, maxRounds = 12) {
  let previousCount = -1;
  let previousHeight = -1;
  let stableRounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    const { count, height } = await page.evaluate((selector) => {
      window.scrollTo(0, document.body.scrollHeight);

      return {
        count: document.querySelectorAll(selector).length,
        height: document.body.scrollHeight,
      };
    }, PRODUCT_ITEM_SELECTOR);

    await page.waitForTimeout(350);

    if (count === previousCount && height === previousHeight) {
      stableRounds++;

      if (stableRounds >= 2) {
        break;
      }
    } else {
      stableRounds = 0;
      previousCount = count;
      previousHeight = height;
    }
  }
}

async function extractProductsFromCurrentPage(page) {
  return page.evaluate((selector) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const extractImage = (value) => {
      if (!value) {
        return '';
      }

      return value.split(',')[0].trim().split(' ')[0].trim();
    };

    const getFirstText = (root, selectors) => {
      for (const itemSelector of selectors) {
        const text = normalize(root.querySelector(itemSelector)?.textContent || '');
        if (text) {
          return text;
        }
      }

      return '';
    };

    const getFirstHref = (root, selectors) => {
      for (const itemSelector of selectors) {
        const href = root.querySelector(itemSelector)?.href || '';
        if (href) {
          return href;
        }
      }

      return '';
    };

    return Array.from(document.querySelectorAll(selector))
      .map((item) => {
        const name = getFirstText(item, [
          'h2.product-name',
          '.product-name',
          '.product-item-name',
          '.product-item-link',
          'a.product-image.figure',
          'a.product-image',
        ]);
        const price = getFirstText(item, ['span.regular-price', '.regular-price', '.price-box .price', '.price']);
        const imgElement = item.querySelector('img.small-img, img.product-image-photo, img');
        const attributes = ['src', 'data-src', 'srcset', 'data-srcset', 'data-lazy', 'data-original'];
        let img = '';

        if (imgElement) {
          for (const attribute of attributes) {
            const value = imgElement.getAttribute(attribute);

            if (value && value.trim()) {
              img = extractImage(value);

              if (img) {
                break;
              }
            }
          }
        }

        const productUrl = getFirstHref(item, [
          'a.product-image.figure',
          'a.product-image',
          'h2.product-name a',
          '.product-name a',
          '.product-item-name a',
          '.product-item-link',
          'a[href]',
        ]);

        if (!name && !price && !img && !productUrl) {
          return null;
        }

        return {
          name,
          price,
          img,
          product_url: productUrl,
          sku: '',
          description: '',
        };
      })
      .filter(Boolean);
  }, PRODUCT_ITEM_SELECTOR);
}

async function scrapeProductListing(url, pool, maxPages) {
  const page = await pool.acquire();
  const products = [];
  const seenProducts = new Set();

  try {
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const pageUrl = buildProductPageUrl(url, pageNumber);
      await gotoPageWithCloudflareCheck(page, pageUrl);

      try {
        await page.waitForSelector(PRODUCT_ITEM_SELECTOR, {
          state: 'attached',
          timeout: Math.min(config.requestTimeout, 20000),
        });
      } catch (error) {
        if (pageNumber === 1) {
          throw error;
        }

        break;
      }

      await autoScrollUntilStable(page);

      for (const product of await extractProductsFromCurrentPage(page)) {
        const productKey = getProductKey(product);

        if (seenProducts.has(productKey)) {
          continue;
        }

        seenProducts.add(productKey);
        products.push(product);
      }

      if (maxPages <= 1) {
        break;
      }
    }

    return products;
  } finally {
    await pool.release(page);
  }
}

function getProductDetailFromCache(productUrl) {
  const cached = detailCache.get(productUrl);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > config.detailCacheTtlMs) {
    detailCache.delete(productUrl);
    return null;
  }

  return cached.data;
}

function setProductDetailCache(productUrl, data) {
  if (!productUrl) {
    return;
  }

  if (detailCache.size >= config.maxCacheItems) {
    const oldestKey = detailCache.keys().next().value;
    if (oldestKey) {
      detailCache.delete(oldestKey);
    }
  }

  detailCache.set(productUrl, {
    createdAt: Date.now(),
    data,
  });
}

async function scrapeProductDetails(page, productUrl) {
  if (!productUrl) {
    return { sku: '', description: '' };
  }

  await gotoPageWithCloudflareCheck(page, productUrl);

  await page
    .waitForFunction(
      (selectors) =>
        selectors.some((selector) => {
          const element = document.querySelector(selector);
          return (element?.textContent || element?.innerHTML || element?.getAttribute('content') || '')
            .replace(/\s+/g, ' ')
            .trim();
        }),
      PRODUCT_DETAIL_READY_SELECTORS,
      { timeout: config.productDetailTimeout }
    )
    .catch(() => {});

  return page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const getValueBySelectors = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text = normalize(element?.textContent);
        const content = normalize(element?.getAttribute('content'));
        const value = normalize(element?.getAttribute('value'));
        const resolvedValue = text || content || value;

        if (resolvedValue) {
          return resolvedValue;
        }
      }

      return '';
    };

    const getHtmlBySelectors = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const html = element?.innerHTML?.trim();

        if (html) {
          return html;
        }
      }

      return '';
    };

    const getStructuredProduct = () => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

      for (const script of scripts) {
        try {
          const parsed = JSON.parse(script.textContent || '');
          const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
          const product = nodes.find((node) => `${node?.['@type'] || ''}`.toLowerCase() === 'product');

          if (product) {
            return {
              sku: normalize(product.sku || product.mpn || ''),
              description: normalize(product.description || ''),
            };
          }
        } catch (error) {
          // Ignore broken JSON-LD and use DOM selectors below.
        }
      }

      return { sku: '', description: '' };
    };

    const structuredProduct = getStructuredProduct();
    const sku = (
      structuredProduct.sku ||
      getValueBySelectors([
        '[itemprop="sku"]',
        '.product-info-stock-sku .value',
        '.product.attribute.sku .value',
        '.sku .value',
        '.sku',
      ])
    ).replace(/^SKU\s*[:#-]?\s*/i, '');

    let description = getHtmlBySelectors([
      '#product_tabs_description_tabbed_contents',
      '#description',
      '#product_tabs_description_contents',
      '.product.attribute.description .value',
      '.product-collateral .description',
      '.short-description',
      '.product-description',
      '[itemprop="description"]',
    ]);

    if (!description && structuredProduct.description) {
      description = structuredProduct.description;
    }

    if (!description) {
      description = getValueBySelectors(['meta[name="description"]', 'meta[property="og:description"]']);
    }

    if (!description) {
      const title = Array.from(document.querySelectorAll('h2, h3, h4, .data.item.title, .title'))
        .find((element) => normalize(element.textContent).toLowerCase().includes('description'));

      const content = title?.nextElementSibling;
      description = content?.innerHTML?.trim() || '';
    }

    return {
      sku: normalize(sku),
      description: description || '',
    };
  });
}

async function hydrateSingleProduct(product, pool) {
  const cached = getProductDetailFromCache(product.product_url);
  if (cached) {
    product.sku = cached.sku;
    product.description = cached.description;
    return;
  }

  const page = await pool.acquire();

  try {
    const details = await scrapeProductDetails(page, product.product_url);
    const normalizedDetails = {
      sku: normalizeText(details.sku),
      description: (details.description || '').trim(),
    };

    setProductDetailCache(product.product_url, normalizedDetails);
    product.sku = normalizedDetails.sku;
    product.description = normalizedDetails.description;
  } finally {
    await pool.release(page);
  }
}

async function hydrateProductDetails(products, pool) {
  const uniqueProductsByUrl = new Map();

  for (const product of products) {
    if (product.product_url && !uniqueProductsByUrl.has(product.product_url)) {
      uniqueProductsByUrl.set(product.product_url, product);
    }
  }

  const uniqueProducts = Array.from(uniqueProductsByUrl.values());
  let nextIndex = 0;
  const workerCount = Math.min(config.detailConcurrency, config.maxConcurrentPages, uniqueProducts.length || 1);

  async function runWorker() {
    while (nextIndex < uniqueProducts.length) {
      const index = nextIndex++;
      const product = uniqueProducts[index];

      for (let attempt = 0; attempt <= config.retryCount; attempt++) {
        try {
          await hydrateSingleProduct(product, pool);
          break;
        } catch (error) {
          if (attempt >= config.retryCount) {
            product.sku = '';
            product.description = '';
            console.error(`Product detail fetch failed for ${product.product_url}: ${error.message}`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  for (const product of products) {
    if (!product.product_url) {
      continue;
    }

    const details = getProductDetailFromCache(product.product_url);
    if (details) {
      product.sku = details.sku;
      product.description = details.description;
    }
  }
}

async function extractCategoryGroups(page, mainCategorySelector) {
  return page.evaluate((selector) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const topLinks = Array.from(document.querySelectorAll(selector));

    return topLinks
      .map((link) => {
        const mainCategoryName = normalize(
          link.textContent ||
            link.getAttribute('aria-label') ||
            link.querySelector('img')?.getAttribute('alt') ||
            link.querySelector('img')?.getAttribute('title') ||
            ''
        );
        const mainCategory = link.closest('li') || link.parentElement;
        const seen = new Set();
        const categories = Array.from(mainCategory?.querySelectorAll('a[href]') || [])
          .map((categoryLink) => {
            const rawUrl = (categoryLink.getAttribute('href') || '').trim();
            const image = categoryLink.querySelector('img');
            const name = normalize(
              categoryLink.textContent ||
                categoryLink.getAttribute('aria-label') ||
                image?.getAttribute('alt') ||
                image?.getAttribute('title') ||
                ''
            );
            const url = categoryLink.href;

            if (!name || !rawUrl || rawUrl === '#' || rawUrl.startsWith('javascript:')) {
              return null;
            }

            const key = `${name}|${url}`;
            if (seen.has(key)) {
              return null;
            }

            seen.add(key);
            return { name, url };
          })
          .filter(Boolean);

        if (!mainCategoryName && !categories.length) {
          return null;
        }

        return {
          mainCategory: mainCategoryName,
          count: categories.length,
          categories,
        };
      })
      .filter(Boolean);
  }, mainCategorySelector);
}

async function openPlaywrightAndGetCategories() {
  const pool = await getPagePool();
  const page = await pool.acquire();

  try {
    await gotoPageWithCloudflareCheck(page, TARGET_URL);
    const mainCategorySelector = await waitForCategoryMenu(page);
    let categoryGroups = await extractCategoryGroups(page, mainCategorySelector);

    // Some themes load submenu links only after hover. Use hover only as a fallback.
    const needsHoverFallback = categoryGroups.some((group) => group.count <= 1);
    if (needsHoverFallback) {
      const count = await page.locator(mainCategorySelector).count();
      for (let index = 0; index < count; index++) {
        await page.locator(mainCategorySelector).nth(index).hover().catch(() => {});
        await page.waitForTimeout(150);
      }

      categoryGroups = await extractCategoryGroups(page, mainCategorySelector);
    }

    return categoryGroups;
  } finally {
    await pool.release(page);
  }
}

async function openPlaywrightAndGetProducts(url, options = {}) {
  const pool = await getPagePool();
  const maxPages = options.maxPages || config.maxProductPages;
  const includeDetails = options.includeDetails ?? config.scrapeDetails;
  const products = await scrapeProductListing(url, pool, maxPages);

  if (includeDetails) {
    await hydrateProductDetails(products, pool);
  }

  return products;
}

async function openTargetUrl(request, response) {
  try {
    const categoryGroups = await openPlaywrightAndGetCategories();
    const totalCategories = categoryGroups.reduce((total, group) => total + group.count, 0);

    response.json({
      success: true,
      url: TARGET_URL,
      mainCategoryCount: categoryGroups.length,
      totalCategories,
      data: categoryGroups,
    });
  } catch (error) {
    response.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

async function getProduct(request, response) {
  const processStartedAt = new Date();
  const processStartedMs = Date.now();
  const rawUrl = request.query.url;

  console.log(`Open http://localhost:${PORT}/getProduct?url=${rawUrl || ''}`);

  if (!rawUrl) {
    return response.status(400).json({
      success: false,
      message: 'URL parameter is required.',
    });
  }

  let url;
  try {
    url = validateTargetUrl(rawUrl);
  } catch (error) {
    return response.status(400).json({
      success: false,
      message: error.message,
    });
  }

  const maxPages = getLimitedPositiveInt(request.query.pages, config.maxProductPages, 25);
  const includeDetails = readQueryBoolean(request.query.details, config.scrapeDetails);

  try {
    const products = await openPlaywrightAndGetProducts(url, { maxPages, includeDetails });
    const processFinishedAt = new Date();

    return response.json({
      success: true,
      url,
      count: products.length,
      include_details: includeDetails,
      max_pages: maxPages,
      cache_items: detailCache.size,
      process_start_date: isoSeconds(processStartedAt),
      process_end_date: isoSeconds(processFinishedAt),
      sync_minutes: Number(((Date.now() - processStartedMs) / 60000).toFixed(2)),
      data: products,
    });
  } catch (error) {
    const processFinishedAt = new Date();

    return response.status(500).json({
      success: false,
      url,
      error: error.message,
      include_details: includeDetails,
      max_pages: maxPages,
      process_start_date: isoSeconds(processStartedAt),
      process_end_date: isoSeconds(processFinishedAt),
      sync_minutes: Number(((Date.now() - processStartedMs) / 60000).toFixed(2)),
    });
  }
}

app.get('/', (request, response) => {
  response.json({
    status: 'running',
    getCategory: `http://localhost:${PORT}/getCategory`,
    getProduct: `http://localhost:${PORT}/getProduct?url=<category-url>&details=1&pages=1`,
    config: {
      maxConcurrentPages: config.maxConcurrentPages,
      detailConcurrency: config.detailConcurrency,
      maxProductPages: config.maxProductPages,
      scrapeDetails: config.scrapeDetails,
      blockImages: config.blockImages,
      headless: config.headless,
      userDataDir: config.userDataDir,
    },
  });
});

app.get('/getCategory', openTargetUrl);
app.get('/getProduct', getProduct);
app.get('/clear-cache', (request, response) => {
  detailCache.clear();
  response.json({ success: true, message: 'Product detail cache cleared.' });
});

const server = app
  .listen(PORT, () => {
    console.log(`Node server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/getCategory to launch ${TARGET_URL} in Chrome.`);
    console.log(`Persistent profile: ${config.userDataDir}`);
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error('Stop the existing server or run with a different port, for example: PORT=3002 node serverms_optimized.js');
      process.exit(1);
    }

    throw error;
  });

async function shutdown() {
  server.close(async () => {
    await pagePool?.close().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
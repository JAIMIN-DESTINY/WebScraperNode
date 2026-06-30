const express = require('express');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');
const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

const PORT = readPositiveInt('PORT', 3001);
const TARGET_URL = 'https://www.mobilesentrix.com/';
const PRODUCT_ITEM_SELECTOR = 'li.item';
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
];
const CATEGORY_MENU_LINK_SELECTORS = [
  '.mob-desk-menu > li > a',
  '.mob-desk-menu a[href]',
  '.nav-primary > li > a',
  '.nav-primary a[href]',
  '.navigation .level0 > a',
  '.navigation a[href]',
  '#nav > li > a',
  '#nav a[href]',
];
const DESKTOP_USER_AGENT =
  process.env.CHROME_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const config = {
  workers: readPositiveInt('PLAYWRIGHT_WORKERS', 50),
  maxConcurrentPages: readPositiveInt('MAX_CONCURRENT_PAGES', readPositiveInt('PLAYWRIGHT_WORKERS', 50)),
  requestTimeout: readPositiveInt('REQUEST_TIMEOUT', 60000),
  retryCount: Math.max(0, readInteger('RETRY_COUNT', 2)),
  headless: readBoolean('HEADLESS', true),
  redisUrl: (process.env.REDIS_URL || '').trim(),
  browserPoolSize: readPositiveInt('BROWSER_POOL_SIZE', 1),
  maxProductPages: readPositiveInt('MAX_PRODUCT_PAGES', 1),
  cloudflareRetries: readPositiveInt('CLOUDFLARE_RETRIES', 3),
  cloudflareWaitMs: readPositiveInt('CLOUDFLARE_WAIT_MS', 5000),
  locale: process.env.PLAYWRIGHT_LOCALE || 'en-US',
  timezoneId: process.env.PLAYWRIGHT_TIMEZONE || 'America/New_York',
};

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

function createLaunchOptions() {
  const launchOptions = {
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
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

async function createOptimizedContext(browser) {
  const context = await browser.newContext({
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
      'Cache-Control': 'no-cache',
    },
  });

  context.setDefaultTimeout(config.requestTimeout);
  context.setDefaultNavigationTimeout(config.requestTimeout);
  await configureContext(context);

  return context;
}

async function configureContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  await context.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();

    if (['font', 'media'].includes(resourceType)) {
      return route.abort();
    }

    return route.continue();
  });
}

class BrowserPagePool {
  constructor(pageCount) {
    this.pageCount = pageCount;
    this.browsers = [];
    this.contexts = [];
    this.availablePages = [];
    this.waiters = [];
  }

  async start() {
    const browserCount = Math.min(config.browserPoolSize, this.pageCount);
    const pagesPerBrowser = Math.ceil(this.pageCount / browserCount);

    for (let browserIndex = 0; browserIndex < browserCount; browserIndex++) {
      const browser = await chromium.launch(createLaunchOptions());
      const context = await createOptimizedContext(browser);

      this.browsers.push(browser);
      this.contexts.push(context);

      const remainingPages = this.pageCount - this.availablePages.length;
      const pagesToCreate = Math.min(pagesPerBrowser, remainingPages);

      for (let pageIndex = 0; pageIndex < pagesToCreate; pageIndex++) {
        const page = await context.newPage();
        page.setDefaultTimeout(config.requestTimeout);
        page.setDefaultNavigationTimeout(config.requestTimeout);
        this.availablePages.push(page);
      }
    }
  }

  async acquire() {
    const page = this.availablePages.pop();

    if (page) {
      return page;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(page) {
    const waiter = this.waiters.shift();

    if (waiter) {
      waiter(page);
      return;
    }

    this.availablePages.push(page);
  }

  async close() {
    await Promise.all(
      this.contexts.map((context) => context.close().catch((error) => {
        console.error(`Playwright context close failed: ${error.message}`);
      }))
    );
    await Promise.all(
      this.browsers.map((browser) => browser.close().catch((error) => {
        console.error(`Playwright browser close failed: ${error.message}`);
      }))
    );
  }
}

class IsolatedPagePool {
  constructor(pageCount) {
    this.pageCount = pageCount;
    this.browsers = [];
    this.activePages = 0;
    this.waiters = [];
    this.nextBrowserIndex = 0;
  }

  async start() {
    const browserCount = Math.min(config.browserPoolSize, this.pageCount);

    for (let index = 0; index < browserCount; index++) {
      this.browsers.push(await chromium.launch(createLaunchOptions()));
    }
  }

  async acquire() {
    if (this.activePages >= this.pageCount) {
      await new Promise((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.activePages++;

    try {
      const browser = this.browsers[this.nextBrowserIndex % this.browsers.length];
      this.nextBrowserIndex++;
      const context = await createOptimizedContext(browser);
      const page = await context.newPage();
      page.setDefaultTimeout(config.requestTimeout);
      page.setDefaultNavigationTimeout(config.requestTimeout);
      return page;
    } catch (error) {
      this.activePages--;
      this.releaseWaiter();
      throw error;
    }
  }

  async release(page) {
    await page.context().close().catch((error) => {
      console.error(`Playwright isolated context close failed: ${error.message}`);
    });

    this.activePages--;
    this.releaseWaiter();
  }

  releaseWaiter() {
    const waiter = this.waiters.shift();

    if (waiter) {
      waiter();
    }
  }

  async close() {
    await Promise.all(
      this.browsers.map((browser) => browser.close().catch((error) => {
        console.error(`Playwright browser close failed: ${error.message}`);
      }))
    );
  }
}

async function gotoPage(page, url, waitUntil = 'domcontentloaded') {
  await page.goto(url, {
    waitUntil,
    timeout: config.requestTimeout,
  });
  await page.waitForLoadState('domcontentloaded', { timeout: config.requestTimeout }).catch(() => {});
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
    text.includes('performance and security by cloudflare')
  );
}

async function gotoPageWithCloudflareRetry(page, url) {
  let lastDebugInfo = null;

  for (let attempt = 1; attempt <= config.cloudflareRetries; attempt++) {
    await gotoPage(page, url);
    await page.waitForSelector('body', { state: 'attached', timeout: config.requestTimeout }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: config.cloudflareWaitMs }).catch(() => {});

    lastDebugInfo = await getPageDebugInfo(page);

    if (!isCloudflareChallenge(lastDebugInfo)) {
      return;
    }

    console.error(
      `Cloudflare verification page detected for ${url}; retrying ${attempt}/${config.cloudflareRetries}.`
    );
    await page.waitForTimeout(config.cloudflareWaitMs * attempt);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.requestTimeout }).catch(() => {});
  }

  throw new Error(
    `Cloudflare verification did not clear. title="${lastDebugInfo?.title || ''}" url="${lastDebugInfo?.url || url}" body="${lastDebugInfo?.bodyText || ''}"`
  );
}

async function waitForCategoryMenu(page, timeoutMs = 60000) {
  await page.waitForSelector('body', { state: 'attached', timeout: config.requestTimeout });

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of CATEGORY_MENU_LINK_SELECTORS) {
      const count = await page.locator(selector).count();

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

async function autoScrollUntilStable(page, maxRounds = 25) {
  let previousCount = 0;
  let previousHeight = 0;
  let stableRounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    const { count, height } = await page.evaluate((selector) => {
      window.scrollTo(0, document.body.scrollHeight);

      return {
        count: document.querySelectorAll(selector).length,
        height: document.body.scrollHeight,
      };
    }, PRODUCT_ITEM_SELECTOR);

    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});

    if (count === previousCount && height === previousHeight) {
      stableRounds++;

      if (stableRounds >= 3) {
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

    return Array.from(document.querySelectorAll(selector))
      .map((item) => {
        const name = normalize(item.querySelector('h2.product-name')?.textContent || '');
        const price = normalize(
          item.querySelector('span.regular-price')?.textContent ||
            item.querySelector('.price')?.textContent ||
            ''
        );
        const imgElement = item.querySelector('img.small-img');
        const attributes = ['src', 'data-src', 'srcset', 'data-lazy', 'data-original'];
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

        const productUrl = item.querySelector('a.product-image.figure')?.href || '';

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

async function scrapeProductListing(url, pagePool) {
  const page = await pagePool.acquire();
  const products = [];
  const seenProducts = new Set();

  try {
    for (let pageNumber = 1; pageNumber <= config.maxProductPages; pageNumber++) {
      const pageUrl = buildProductPageUrl(url, pageNumber);
      await gotoPage(page, pageUrl);

      try {
        await page.waitForSelector(PRODUCT_ITEM_SELECTOR, { state: 'attached', timeout: config.requestTimeout });
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

      if (config.maxProductPages <= 1) {
        break;
      }
    }

    return products;
  } finally {
    await pagePool.release(page);
  }
}

async function scrapeProductDetails(page, productUrl) {
  if (!productUrl) {
    return { sku: '', description: '' };
  }

  await gotoPage(page, productUrl);
  await page.waitForSelector('body', { state: 'attached', timeout: config.requestTimeout });
  await page
    .waitForFunction(
      (selectors) =>
        selectors.some((selector) => {
          const element = document.querySelector(selector);
          return (element?.textContent || element?.innerHTML || '').replace(/\s+/g, ' ').trim();
        }),
      PRODUCT_DETAIL_READY_SELECTORS,
      { timeout: Math.min(config.requestTimeout, 10000) }
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

    const sku = getValueBySelectors([
      '[itemprop="sku"]',
      '.product-info-stock-sku .value',
      '.product.attribute.sku .value',
      '.sku .value',
      '.sku',
    ]).replace(/^SKU\s*[:#-]?\s*/i, '');

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

    if (!description) {
      const title = Array.from(document.querySelectorAll('h2, h3, h4, .data.item.title, .title'))
        .find((element) => normalize(element.textContent).toLowerCase().includes('description'));

      const content = title?.nextElementSibling;
      description = content?.innerHTML?.trim() || '';
    }

    return {
      sku,
      description,
    };
  });
}

async function hydrateSingleProduct(product, pagePool) {
  const page = await pagePool.acquire();

  try {
    const details = await scrapeProductDetails(page, product.product_url);
    product.sku = normalizeText(details.sku);
    product.description = (details.description || '').trim();
  } finally {
    await pagePool.release(page);
  }
}

async function runInMemoryQueue(products, pagePool) {
  let nextIndex = 0;
  const workerCount = Math.min(config.workers, config.maxConcurrentPages, products.length || 1);

  async function runWorker() {
    while (nextIndex < products.length) {
      const index = nextIndex++;
      const product = products[index];

      for (let attempt = 0; attempt <= config.retryCount; attempt++) {
        try {
          await hydrateSingleProduct(product, pagePool);
          break;
        } catch (error) {
          if (attempt >= config.retryCount) {
            product.sku = '';
            product.description = '';
            console.error(`Product detail fetch failed for ${product.product_url}: ${error.message}`);
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function createRedisConnection() {
  if (!config.redisUrl) {
    return null;
  }

  const connection = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  try {
    await Promise.race([
      connection.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 3000)),
    ]);
    return connection;
  } catch (error) {
    console.error(`Redis is unavailable; using in-memory queue: ${error.message}`);
    connection.disconnect();
    return null;
  }
}

async function runBullQueue(products, pagePool, connection) {
  const queueName = `mobilesentrix-products-${randomUUID()}`;
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  const worker = new Worker(
    queueName,
    async (job) => {
      const { index } = job.data;
      const product = products[index];
      await hydrateSingleProduct(product, pagePool);
      return { index };
    },
    {
      connection,
      concurrency: Math.min(config.workers, config.maxConcurrentPages),
    }
  );

  try {
    await queueEvents.waitUntilReady();
    const jobs = await queue.addBulk(
      products.map((product, index) => ({
        name: 'scrape-product',
        data: { index, product_url: product.product_url },
        opts: {
          jobId: `product-${index}`,
          attempts: config.retryCount + 1,
          backoff: { type: 'exponential', delay: 500 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      }))
    );

    await Promise.all(
      jobs.map((job) =>
        job.waitUntilFinished(queueEvents).catch((error) => {
          const product = products[job.data.index];
          product.sku = '';
          product.description = '';
          console.error(`Product detail fetch failed for ${product.product_url}: ${error.message}`);
        })
      )
    );
  } finally {
    await worker.close().catch(() => {});
    await queueEvents.close().catch(() => {});
    await queue.close().catch(() => {});
  }
}

async function hydrateProductDetails(products, pagePool) {
  if (!products.length) {
    return;
  }

  const redisConnection = await createRedisConnection();

  if (!redisConnection) {
    await runInMemoryQueue(products, pagePool);
    return;
  }

  try {
    await runBullQueue(products, pagePool, redisConnection);
  } finally {
    await redisConnection.quit().catch(() => redisConnection.disconnect());
  }
}

async function openPlaywrightAndGetCategories() {
  const pagePool = new BrowserPagePool(1);
  let page = null;

  try {
    await pagePool.start();
    page = await pagePool.acquire();
    await gotoPageWithCloudflareRetry(page, TARGET_URL);
    const mainCategorySelector = await waitForCategoryMenu(page);
    const mainCategoryCount = await page.locator(mainCategorySelector).count();
    const categoryGroups = [];

    for (let index = 0; index < mainCategoryCount; index++) {
      const mainCategoryLink = page.locator(mainCategorySelector).nth(index);
      const mainCategoryName = normalizeText(await mainCategoryLink.textContent());

      await mainCategoryLink.scrollIntoViewIfNeeded();
      await mainCategoryLink.hover().catch(() => {});
      await mainCategoryLink.click({ timeout: 5000 }).catch(async () => {
        await mainCategoryLink.evaluate((link) => link.click());
      });

      await page
        .waitForFunction(
          ({ selector, linkIndex }) => {
            const link = document.querySelectorAll(selector)[linkIndex];
            const mainCategory = link?.closest('li');
            return (mainCategory?.querySelectorAll('a[href]').length || 0) > 1;
          },
          { selector: mainCategorySelector, linkIndex: index },
          { timeout: 5000 }
        )
        .catch(() => {});

      const categories = await mainCategoryLink.evaluate((link) => {
        const mainCategory = link.closest('li');

        if (!mainCategory) {
          return [];
        }

        const seen = new Set();

        return Array.from(mainCategory.querySelectorAll('a[href]'))
          .map((categoryLink) => {
            const rawUrl = (categoryLink.getAttribute('href') || '').trim();
            const url = categoryLink.href;
            const image = categoryLink.querySelector('img');
            const name = (
              categoryLink.textContent ||
              categoryLink.getAttribute('aria-label') ||
              image?.getAttribute('alt') ||
              image?.getAttribute('title') ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim();

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
      });

      categoryGroups.push({
        mainCategory: mainCategoryName,
        count: categories.length,
        categories,
      });
    }

    return categoryGroups;
  } finally {
    if (page) {
      await pagePool.release(page);
    }
    await pagePool.close();
  }
}

async function openPlaywrightAndGetProducts(url) {
  const pageCount = Math.min(config.maxConcurrentPages, Math.max(1, config.workers));
  const pagePool = new IsolatedPagePool(pageCount);

  try {
    await pagePool.start();
    const products = await scrapeProductListing(url, pagePool);
    await hydrateProductDetails(products, pagePool);
    return products;
  } finally {
    await pagePool.close();
  }
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
  const { url } = request.query;
  const processStartedAt = new Date();
  const processStartedMs = Date.now();

  console.log(`Open http://localhost:${PORT}/getProduct?url=${url}`);

  if (!url) {
    return response.status(400).json({
      success: false,
      message: 'URL parameter is required.',
    });
  }

  try {
    const products = await openPlaywrightAndGetProducts(url);
    const processFinishedAt = new Date();

    return response.json({
      success: true,
      url,
      count: products.length,
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
      process_start_date: isoSeconds(processStartedAt),
      process_end_date: isoSeconds(processFinishedAt),
      sync_minutes: Number(((Date.now() - processStartedMs) / 60000).toFixed(2)),
    });
  }
}

app.get('/', (request, response) => {
  response.json({
    status: 'running',
    openUrl: `http://localhost:${PORT}/getCategory`,
  });
});

app.get('/getCategory', openTargetUrl);
app.get('/getProduct', getProduct);

const server = app
  .listen(PORT, () => {
    console.log(`Node server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/getCategory to launch ${TARGET_URL} in Chrome.`);
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error('Stop the existing server or run with a different port, for example: PORT=3001 node serverms.js');
      process.exit(1);
    }

    throw error;
  });

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

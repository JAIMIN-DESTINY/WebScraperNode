const express = require('express');
const fs = require('fs');
const path = require('path');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const PORT = readPositiveInt('PORT', 3002);
const TARGET_URL = 'https://www.phonelcdparts.com/';
const PRODUCT_SELECTOR = [
  'form.product-item',
  'form.product_addtocart_form',
  'form[action*="/checkout/cart/add/"]',
].join(', ');
const BLOCKED_PAGE_PATTERNS = [
  'sorry, you have been blocked',
  'you are unable to access',
  'this website is using a security service',
  'please enable cookies',
  'access denied',
];

const config = {
  requestTimeout: readPositiveInt('REQUEST_TIMEOUT', 60000),
  headless: readBoolean('HEADLESS', true),
  maxPages: Math.max(0, readInteger('MAX_PRODUCT_PAGES', 0)),
  maxScrollRounds: readPositiveInt('MAX_SCROLL_ROUNDS', 50),
  scrollDelayMs: readPositiveInt('SCROLL_DELAY_MS', 1500),
  stableScrollRounds: readPositiveInt('STABLE_SCROLL_ROUNDS', 20),
  chromePath: process.env.CHROME_PATH || '',
  chromeDriverPath: process.env.CHROMEDRIVER_PATH || '',
  chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || '',
  proxyServer: process.env.PROXY_SERVER || process.env.PLAYWRIGHT_PROXY_SERVER || '',
};

const app = express();

class AccessBlockedError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'AccessBlockedError';
    this.diagnostics = diagnostics;
  }
}

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

function isoSeconds(date) {
  return date.toISOString().slice(0, 19);
}

function isAllowedUrl(value) {
  try {
    const parsedUrl = new URL(value);
    return ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch (error) {
    return false;
  }
}

function createChromeOptions() {
  const options = new chrome.Options();

  options.addArguments(
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080'
  );

  if (config.headless) {
    options.addArguments('--headless=new');
  }

  if (config.chromePath) {
    options.setChromeBinaryPath(config.chromePath);
  }

  if (config.chromeUserDataDir) {
    options.addArguments(`--user-data-dir=${config.chromeUserDataDir}`);
  }

  if (config.proxyServer) {
    options.addArguments(`--proxy-server=${config.proxyServer}`);
  }

  return options;
}

async function createDriver() {
  const builder = new Builder()
    .forBrowser('chrome')
    .setChromeOptions(createChromeOptions());
  const originalPath = process.env.PATH;

  if (config.chromeDriverPath) {
    builder.setChromeService(new chrome.ServiceBuilder(config.chromeDriverPath));
  } else {
    process.env.PATH = removeChromeDriverFromPath(process.env.PATH || '');
  }

  let driver;

  try {
    driver = await builder.build();
  } finally {
    process.env.PATH = originalPath;
  }

  await driver.manage().setTimeouts({
    implicit: 1000,
    pageLoad: config.requestTimeout,
    script: config.requestTimeout,
  });

  return driver;
}

function removeChromeDriverFromPath(value) {
  return value
    .split(path.delimiter)
    .filter((directory) => directory && !fs.existsSync(path.join(directory, 'chromedriver')))
    .join(path.delimiter);
}

async function gotoPage(driver, url) {
  console.log(`Loading: ${url}`);
  await driver.get(url);
  await driver.wait(
    async () => ['interactive', 'complete'].includes(await driver.executeScript('return document.readyState')),
    config.requestTimeout
  );
  await driver.sleep(3000);
  await acceptCookies(driver);
  await assertAccessAllowed(driver);
  await waitForProducts(driver);
}

async function acceptCookies(driver) {
  const selectors = [
    '#btn-cookie-allow',
    '.action.allow.primary',
    'button[aria-label*="Accept"]',
    'button[title*="Accept"]',
  ];

  for (const selector of selectors) {
    const buttons = await driver.findElements(By.css(selector));

    if (buttons.length === 0) {
      continue;
    }

    await buttons[0].click().catch(() => {});
    await driver.sleep(300);
    return;
  }
}

async function waitForProducts(driver) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < Math.min(config.requestTimeout, 15000)) {
    const productCount = (await driver.findElements(By.css(PRODUCT_SELECTOR))).length;
    const productLinkCount = (await driver.findElements(By.css('a.product-item-link[href], a.product-item-photo[href]'))).length;

    if (productCount > 0 || productLinkCount > 0) {
      return;
    }

    await assertAccessAllowed(driver);
    await driver.sleep(500);
  }

  const diagnostics = await getListingDiagnostics(driver);
  throwIfBlocked(diagnostics);
  console.error(`PhoneLCDParts product listing did not become ready: ${JSON.stringify(diagnostics)}`);
}

async function autoScrollUntilStable(driver) {
  let previousCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < config.maxScrollRounds; round++) {
    await driver.executeScript(`
      window.scrollBy(0, Math.max(window.innerHeight * 0.85, 1000));
      document.querySelectorAll('img').forEach((image) => {
        for (const key of ['src', 'original', 'lazy']) {
          const value = image.dataset && image.dataset[key];
          if (value && !image.getAttribute('src')) image.setAttribute('src', value);
        }
      });
    `);
    await driver.sleep(config.scrollDelayMs);

    const count = (await driver.findElements(By.css(PRODUCT_SELECTOR))).length;
    console.log(`Scroll ${round + 1} -> ${count} products`);

    if (count === previousCount) {
      stableRounds++;

      if (stableRounds >= (count === 0 ? 5 : config.stableScrollRounds)) {
        break;
      }
    } else {
      previousCount = count;
      stableRounds = 0;
    }
  }

  await driver.executeScript('window.scrollTo(0, document.body.scrollHeight);');
  await driver.sleep(500);
}

async function extractProducts(driver) {
  return driver.executeScript(
    ({ productSelector, blockedPatterns }) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const absoluteUrl = (value) => {
        if (!value) return '';

        try {
          return new URL(value, window.location.origin).toString();
        } catch (error) {
          return '';
        }
      };
      const firstImageFromValue = (value) => (value || '').split(',')[0].trim().split(' ')[0].trim();
      const imageFromElement = (image) => {
        if (!image) return '';

        for (const attribute of ['src', 'data-src', 'data-original', 'data-lazy', 'data-srcset', 'srcset']) {
          const imageUrl = firstImageFromValue(image.getAttribute(attribute));

          if (imageUrl && !imageUrl.startsWith('data:') && !imageUrl.includes('/colortag/')) {
            return absoluteUrl(imageUrl);
          }
        }

        return '';
      };
      const isProductUrl = (url) => {
        if (!url) return false;

        try {
          const parsedUrl = new URL(url, window.location.origin);
          return (
            parsedUrl.hostname === window.location.hostname &&
            !parsedUrl.pathname.includes('/checkout/') &&
            !parsedUrl.pathname.includes('/customer/') &&
            !parsedUrl.pathname.includes('/wishlist/') &&
            !parsedUrl.pathname.includes('/catalogsearch/')
          );
        } catch (error) {
          return false;
        }
      };
      const findText = (item, selectors) => {
        for (const selector of selectors) {
          const text = normalize(item.querySelector(selector)?.textContent);

          if (text) {
            return text;
          }
        }

        return '';
      };
      const findLink = (item) =>
        item.querySelector('a.product-item-link[href]') ||
        item.querySelector('a.product-item-photo[href]') ||
        item.querySelector('a[href]');
      const findImage = (item) => {
        for (const selector of ['img.product-image-photo', '.product-item-photo img', 'img']) {
          const image = imageFromElement(item.querySelector(selector));

          if (image) {
            return image;
          }
        }

        return '';
      };
      const findSku = (item) =>
        normalize(
          item.getAttribute('data-sku') ||
            item.querySelector('[data-sku]')?.getAttribute('data-sku') ||
            item.querySelector('[name="sku"]')?.getAttribute('value') ||
            item.querySelector('.sku .value')?.textContent ||
            ''
        ).replace(/^SKU\s*[:#-]?\s*/i, '');

      const pageText = normalize(`${document.title} ${document.body?.textContent || ''}`).toLowerCase();

      if (blockedPatterns.some((pattern) => pageText.includes(pattern))) {
        return { blocked: true, data: [] };
      }

      const itemSet = new Set(Array.from(document.querySelectorAll(productSelector)));

      if (itemSet.size === 0) {
        document.querySelectorAll('a.product-item-link[href], a.product-item-photo[href]').forEach((link) => {
          const item = link.closest('form, li, article, .product-item, .product, .card, [data-product-id]') || link.parentElement;

          if (item) {
            itemSet.add(item);
          }
        });
      }

      return {
        blocked: false,
        data: Array.from(itemSet)
          .map((item) => {
            const link = findLink(item);
            const productUrl = absoluteUrl(link?.getAttribute('href') || '');

            if (!isProductUrl(productUrl)) {
              return null;
            }

            const image = findImage(item);
            const name =
              findText(item, ['.product-item-link', '.product-item-name', '.product.name']) ||
              normalize(link?.getAttribute('title')) ||
              normalize(item.querySelector('img')?.getAttribute('alt'));
            const price = findText(item, [
              '[data-price-type="finalPrice"] .price',
              '.special-price .price',
              '.price-final_price .price',
              '.price-box .price',
              '.price',
            ]) || (normalize(item.textContent).match(/Login To See Price|\$[\d,.]+/i)?.[0] || '');

            if (!name && !productUrl && !price && !image) {
              return null;
            }

            return {
              image,
              img: image,
              name,
              product_url: productUrl,
              price,
              sku: findSku(item),
              description: '',
            };
          })
          .filter(Boolean),
      };
    },
    { productSelector: PRODUCT_SELECTOR, blockedPatterns: BLOCKED_PAGE_PATTERNS }
  ).then((result) => {
    if (result?.blocked) {
      throw new AccessBlockedError('PhoneLCDParts blocked this scraper host.', { url: '', title: 'Blocked' });
    }

    return result?.data || [];
  });
}

async function getNextPageUrl(driver, seenPageUrls) {
  const nextUrl = await driver.executeScript(() => {
    const link = Array.from(document.querySelectorAll('a.action.next, .pages-item-next a, li.pages-item-next a, a.next'))
      .find((element) => {
        const ariaDisabled = element.getAttribute('aria-disabled');
        const parentDisabled = element.closest('li')?.classList.contains('disabled');
        return ariaDisabled !== 'true' && !parentDisabled && element.getAttribute('href');
      });

    if (!link) return '';

    try {
      return new URL(link.getAttribute('href'), window.location.href).toString();
    } catch (error) {
      return '';
    }
  });

  return nextUrl && !seenPageUrls.has(nextUrl) ? nextUrl : '';
}

async function getListingDiagnostics(driver) {
  return driver.executeScript(
    ({ productSelector, blockedPatterns }) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const title = normalize(document.querySelector('h1')?.textContent || document.title);
      const bodyText = normalize(document.body?.textContent || '').slice(0, 300);
      const pageText = `${title} ${bodyText}`.toLowerCase();

      return {
        url: window.location.href,
        title,
        itemCount: document.querySelectorAll(productSelector).length,
        productLinkCount: document.querySelectorAll('a.product-item-link, a.product-item-photo').length,
        blocked: blockedPatterns.some((pattern) => pageText.includes(pattern)),
        bodyText,
      };
    },
    { productSelector: PRODUCT_SELECTOR, blockedPatterns: BLOCKED_PAGE_PATTERNS }
  );
}

async function assertAccessAllowed(driver) {
  throwIfBlocked(await getListingDiagnostics(driver));
}

function throwIfBlocked(diagnostics) {
  if (!diagnostics?.blocked) {
    return;
  }

  throw new AccessBlockedError(
    'PhoneLCDParts blocked this scraper host. Use a real Chrome profile/cookies, proxy, or allowlist this server IP.',
    diagnostics
  );
}

async function scrapeProducts(url) {
  const driver = await createDriver();
  const products = [];
  const seenProducts = new Set();
  const seenPageUrls = new Set();
  let currentUrl = url;
  let pageNumber = 0;

  try {
    while (currentUrl) {
      pageNumber++;

      if (config.maxPages > 0 && pageNumber > config.maxPages) {
        break;
      }

      seenPageUrls.add(currentUrl);
      await gotoPage(driver, currentUrl);
      await autoScrollUntilStable(driver);

      for (const product of await extractProducts(driver)) {
        const key = product.product_url || [product.name, product.price, product.image].join('|');

        if (seenProducts.has(key)) {
          continue;
        }

        seenProducts.add(key);
        products.push(product);
      }

      currentUrl = await getNextPageUrl(driver, seenPageUrls);
    }

    return products;
  } finally {
    await driver.quit().catch((error) => {
      console.error(`Chrome close failed: ${error.message}`);
    });
  }
}

async function handleScrape(request, response) {
  const { url } = request.query;
  const processStartedAt = new Date();
  const processStartedMs = Date.now();

  console.log(`Open http://localhost:${PORT}/getProduct?url=${url || ''}`);

  if (!url) {
    return response.status(400).json({
      success: false,
      message: 'URL parameter is required.',
    });
  }

  if (!isAllowedUrl(url)) {
    return response.status(400).json({
      success: false,
      message: 'URL parameter must be a valid http/https URL.',
    });
  }

  try {
    const products = await scrapeProducts(url);
    const processFinishedAt = new Date();

    return response.json({
      success: true,
      url,
      count: products.length,
      total: products.length,
      process_start_date: isoSeconds(processStartedAt),
      process_end_date: isoSeconds(processFinishedAt),
      sync_minutes: Number(((Date.now() - processStartedMs) / 60000).toFixed(2)),
      data: products,
    });
  } catch (error) {
    const processFinishedAt = new Date();
    const isBlocked = error instanceof AccessBlockedError;

    return response.status(isBlocked ? 403 : 500).json({
      success: false,
      url,
      blocked: isBlocked,
      error: error.message,
      diagnostics: isBlocked ? error.diagnostics : undefined,
      process_start_date: isoSeconds(processStartedAt),
      process_end_date: isoSeconds(processFinishedAt),
      sync_minutes: Number(((Date.now() - processStartedMs) / 60000).toFixed(2)),
    });
  }
}

app.get('/', (request, response) => {
  response.json({
    status: 'running',
    getProduct: `http://localhost:${PORT}/getProduct?url=${encodeURIComponent(TARGET_URL)}`,
    scrape: `http://localhost:${PORT}/scrape?url=${encodeURIComponent(TARGET_URL)}`,
  });
});

app.get('/getProduct', handleScrape);
app.get('/scrape', handleScrape);

const server = app
  .listen(PORT, () => {
    console.log(`PhoneLCDParts Selenium scraper running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/getProduct?url=${TARGET_URL}`);
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error('Stop the existing server or run with another port, for example: PORT=3007 node serverplp.js');
      process.exit(1);
    }

    throw error;
  });

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

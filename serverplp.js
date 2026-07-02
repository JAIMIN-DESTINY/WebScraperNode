const express = require('express');
const { chromium } = require('playwright');

const PORT = readPositiveInt('PORT', 3002);
const TARGET_URL = 'https://www.phonelcdparts.com/';
const PRODUCT_ITEM_SELECTORS = [
  'form.product_addtocart_form.product-item',
  'form.product_addtocart_form',
  'form.product-item',
  'form[action*="/checkout/cart/add/"]',
  'form[data-sku][action*="/checkout/cart/add/"]',
  'li.product-item',
  'li.item.product.product-item',
  '.products-grid form.product-item',
  '.products-list form.product-item',
  '.products-grid .product-item',
  '.product-items > li',
];
const PRODUCT_LINK_SELECTORS = [
  'a.product-item-link',
  'strong.product-item-name a',
  '.product.name a',
  'a.product-item-photo',
  'a.product.photo.product-item-photo',
  'a[href*=".html"]',
];
const PRODUCT_NAME_SELECTORS = [
  'a.product-item-link',
  'strong.product-item-name',
  '.product-item-name',
  '.product.name',
];
const PRODUCT_PRICE_SELECTORS = [
  '[data-price-type="finalPrice"] .price',
  '.special-price .price',
  '.price-final_price .price',
  '.price-box .price',
  '.price',
];
const PRODUCT_IMAGE_SELECTORS = [
  'a.product-item-photo img.product-image-photo',
  'a.product.photo.product-item-photo img',
  '.product.photo.product-item-photo img',
  '.product-image-container img',
  'img.product-image-photo',
  '.product-image-wrapper img',
  'img.lazyload',
  'img.lazy',
];
const NEXT_PAGE_SELECTORS = [
  'a.action.next',
  '.pages-item-next a',
  'li.pages-item-next a',
  'a.next',
];
const EMPTY_PRODUCT_SELECTORS = [
  '.message.info.empty',
  '.message.notice',
  '.catalog-empty',
  '.products-empty',
];
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
  browserChannel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || process.env.BROWSER_CHANNEL || 'chrome',
  userDataDir: process.env.CHROME_USER_DATA_DIR || '',
  maxPages: Math.max(0, readInteger('MAX_PRODUCT_PAGES', 0)),
  maxScrollRounds: readPositiveInt('MAX_SCROLL_ROUNDS', 40),
  scrollDelayMs: readPositiveInt('SCROLL_DELAY_MS', 700),
  stableScrollRounds: readPositiveInt('STABLE_SCROLL_ROUNDS', 3),
  locale: process.env.PLAYWRIGHT_LOCALE || 'en-US',
  timezoneId: process.env.PLAYWRIGHT_TIMEZONE || 'America/New_York',
  userAgent: process.env.CHROME_USER_AGENT || '',
  proxyServer: process.env.PLAYWRIGHT_PROXY_SERVER || process.env.PROXY_SERVER || '',
  proxyUsername: process.env.PLAYWRIGHT_PROXY_USERNAME || process.env.PROXY_USERNAME || '',
  proxyPassword: process.env.PLAYWRIGHT_PROXY_PASSWORD || process.env.PROXY_PASSWORD || '',
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

function createLaunchOptions(includeChannel = true) {
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

  if (includeChannel && config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  if (process.env.CHROME_PATH) {
    launchOptions.executablePath = process.env.CHROME_PATH;
    delete launchOptions.channel;
  }

  const proxy = createProxyOptions();

  if (proxy) {
    launchOptions.proxy = proxy;
  }

  return launchOptions;
}

function createProxyOptions() {
  if (!config.proxyServer) {
    return undefined;
  }

  return {
    server: config.proxyServer,
    username: config.proxyUsername || undefined,
    password: config.proxyPassword || undefined,
  };
}

function createContextOptions() {
  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: config.locale,
    timezoneId: config.timezoneId,
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'Accept-Language': `${config.locale},en;q=0.9`,
      'Cache-Control': 'no-cache',
    },
  };

  if (config.userAgent) {
    contextOptions.userAgent = config.userAgent;
  }

  return contextOptions;
}

async function prepareContext(context) {
  context.setDefaultTimeout(config.requestTimeout);
  context.setDefaultNavigationTimeout(config.requestTimeout);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  return context;
}

async function createBrowserSession() {
  if (config.userDataDir) {
    const context = await launchPersistentContext();
    return {
      context,
      close: () => context.close(),
    };
  }

  const browser = await launchBrowser();
  const context = await prepareContext(await browser.newContext(createContextOptions()));

  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function launchBrowser() {
  try {
    return await chromium.launch(createLaunchOptions(true));
  } catch (error) {
    if (!config.browserChannel || process.env.CHROME_PATH) {
      throw error;
    }

    console.error(`Chrome channel "${config.browserChannel}" unavailable, falling back to bundled Chromium: ${error.message}`);
    return chromium.launch(createLaunchOptions(false));
  }
}

async function launchPersistentContext() {
  try {
    return await prepareContext(await chromium.launchPersistentContext(config.userDataDir, {
      ...createLaunchOptions(true),
      ...createContextOptions(),
    }));
  } catch (error) {
    if (!config.browserChannel || process.env.CHROME_PATH) {
      throw error;
    }

    console.error(`Chrome channel "${config.browserChannel}" unavailable, falling back to bundled Chromium: ${error.message}`);
    return prepareContext(await chromium.launchPersistentContext(config.userDataDir, {
      ...createLaunchOptions(false),
      ...createContextOptions(),
    }));
  }
}

async function gotoPage(page, url) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: config.requestTimeout,
  });

  await page.waitForSelector('body', { state: 'attached', timeout: config.requestTimeout });
  await acceptCookies(page);
  await assertAccessAllowed(page);
  await waitForProductItems(page);
}

async function acceptCookies(page) {
  const cookieButtons = [
    '#btn-cookie-allow',
    'button:has-text("Allow Cookies")',
    'button:has-text("Accept")',
    '.action.allow.primary',
  ];

  for (const selector of cookieButtons) {
    const button = page.locator(selector).first();

    if ((await button.count()) === 0) {
      continue;
    }

    await button.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(250);
    break;
  }
}

async function waitForProductItems(page) {
  const selectors = {
    item: PRODUCT_ITEM_SELECTORS.join(', '),
    empty: EMPTY_PRODUCT_SELECTORS.join(', '),
  };
  const waitTimeout = Math.min(config.requestTimeout, 15000);

  const state = await page
    .waitForFunction(
      ({ item, empty }) => {
        const productCount = document.querySelectorAll(item).length;
        const productLinkCount = document.querySelectorAll('a.product-item-link[href], a.product-item-photo[href]').length;
        const cartFormCount = document.querySelectorAll('form[action*="/checkout/cart/add/"], form[data-sku]').length;

        if (productCount > 0 || productLinkCount > 0 || cartFormCount > 0) {
          return { ready: true, productCount, productLinkCount, cartFormCount };
        }

        const emptyMessage = Array.from(document.querySelectorAll(empty))
          .map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())
          .find(Boolean);

        if (emptyMessage) {
          return { ready: true, productCount: 0, emptyMessage };
        }

        return false;
      },
      selectors,
      { timeout: waitTimeout }
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);

  if (state?.ready || state?.emptyMessage) {
    return;
  }

  const diagnostics = await getListingDiagnostics(page, selectors.item);
  throwIfBlocked(diagnostics);
  console.error(`PhoneLCDParts product listing did not become ready: ${JSON.stringify(diagnostics)}`);
}

async function getListingDiagnostics(page, itemSelector) {
  return page
    .evaluate(({ selector, blockedPatterns }) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const title = normalize(document.querySelector('h1')?.textContent || document.title);
      const productLinkCount = document.querySelectorAll('a.product-item-link, a.product-item-photo').length;
      const cartFormCount = document.querySelectorAll('form[action*="/checkout/cart/add/"], form[data-sku]').length;
      const bodyText = normalize(document.body?.textContent || '').slice(0, 300);
      const pageText = `${title} ${bodyText}`.toLowerCase();

      return {
        url: window.location.href,
        title,
        itemCount: document.querySelectorAll(selector).length,
        productLinkCount,
        cartFormCount,
        blocked: blockedPatterns.some((pattern) => pageText.includes(pattern)),
        bodyText,
      };
    }, { selector: itemSelector, blockedPatterns: BLOCKED_PAGE_PATTERNS })
    .catch((error) => ({ error: error.message }));
}

async function assertAccessAllowed(page) {
  const diagnostics = await getListingDiagnostics(page, PRODUCT_ITEM_SELECTORS.join(', '));
  throwIfBlocked(diagnostics);
}

function throwIfBlocked(diagnostics) {
  if (!diagnostics?.blocked) {
    return;
  }

  throw new AccessBlockedError(
    'PhoneLCDParts blocked this scraper host. Configure PLAYWRIGHT_PROXY_SERVER/PROXY_SERVER with an allowed browser-capable proxy or allowlist the live server IP.',
    diagnostics
  );
}

async function autoScrollUntilStable(page) {
  const itemSelector = PRODUCT_ITEM_SELECTORS.join(', ');
  let previousCount = 0;
  let previousHeight = 0;
  let stableRounds = 0;

  for (let round = 0; round < config.maxScrollRounds; round++) {
    const { count, height } = await page.evaluate((selector) => {
      window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));

      document.querySelectorAll('img').forEach((image) => {
        if (image.dataset?.src && !image.getAttribute('src')) {
          image.setAttribute('src', image.dataset.src);
        }

        if (image.dataset?.original && !image.getAttribute('src')) {
          image.setAttribute('src', image.dataset.original);
        }

        if (image.dataset?.lazy && !image.getAttribute('src')) {
          image.setAttribute('src', image.dataset.lazy);
        }
      });

      return {
        count: document.querySelectorAll(selector).length,
        height: document.body.scrollHeight,
      };
    }, itemSelector);

    await page.waitForLoadState('networkidle', { timeout: config.scrollDelayMs }).catch(() => {});
    await page.waitForTimeout(config.scrollDelayMs);

    if (count === previousCount && height === previousHeight) {
      stableRounds++;

      if (stableRounds >= config.stableScrollRounds) {
        break;
      }
    } else {
      stableRounds = 0;
      previousCount = count;
      previousHeight = height;
    }
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
}

async function extractProductsFromCurrentPage(page) {
  const selectors = {
    item: PRODUCT_ITEM_SELECTORS.join(', '),
    link: PRODUCT_LINK_SELECTORS.join(', '),
    name: PRODUCT_NAME_SELECTORS.join(', '),
    price: PRODUCT_PRICE_SELECTORS.join(', '),
    image: PRODUCT_IMAGE_SELECTORS.join(', '),
  };

  return page.evaluate((selectorSet) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const firstImageFromValue = (value) => {
      if (!value) {
        return '';
      }

      return value.split(',')[0].trim().split(' ')[0].trim();
    };
    const absoluteUrl = (value) => {
      if (!value) {
        return '';
      }

      try {
        return new URL(value, window.location.origin).toString();
      } catch (error) {
        return '';
      }
    };
    const imageFromElement = (image) => {
      if (!image) {
        return '';
      }

      const attributes = [
        'src',
        'data-src',
        'data-original',
        'data-lazy',
        'data-amsrc',
        'data-srcset',
        'srcset',
      ];

      for (const attribute of attributes) {
        const imageUrl = firstImageFromValue(image.getAttribute(attribute));

        if (imageUrl && !imageUrl.startsWith('data:') && !imageUrl.includes('/colortag/')) {
          return absoluteUrl(imageUrl);
        }
      }

      return '';
    };
    const findProductImage = (item) => {
      const preferredImage = item.querySelector(selectorSet.image);
      const preferredImageUrl = imageFromElement(preferredImage);

      if (preferredImageUrl) {
        return preferredImageUrl;
      }

      for (const image of Array.from(item.querySelectorAll('img'))) {
        const imageUrl = imageFromElement(image);

        if (imageUrl && !imageUrl.includes('/colortag/')) {
          return imageUrl;
        }
      }

      return '';
    };
    const findProductName = (item, link, image) => {
      const nameElement = item.querySelector(selectorSet.name);
      const candidates = [
        nameElement?.textContent,
        link?.textContent,
        link?.getAttribute('title'),
        image?.getAttribute('alt'),
        image?.getAttribute('title'),
      ];

      return normalize(candidates.find((candidate) => normalize(candidate)) || '');
    };
    const findProductPrice = (item) => {
      const priceElement = item.querySelector(selectorSet.price);
      const price = normalize(priceElement?.textContent || '');

      if (price) {
        return price;
      }

      const priceMatch = normalize(item.textContent).match(/Login To See Price|\$[\d,.]+/i);
      return priceMatch ? priceMatch[0] : '';
    };
    const findProductSku = (item) => {
      const candidates = [
        item.getAttribute('data-sku'),
        item.querySelector('[data-sku]')?.getAttribute('data-sku'),
        item.querySelector('[name="sku"]')?.getAttribute('value'),
        item.querySelector('.sku .value')?.textContent,
        item.querySelector('.product-item-details .block strong')?.textContent,
      ];

      return normalize(candidates.find((candidate) => normalize(candidate)) || '').replace(/^SKU\s*[:#-]?\s*/i, '');
    };
    const isProductUrl = (url) => {
      if (!url) {
        return false;
      }

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
    const findContainerForLink = (link) => {
      const productContainer = link.closest(selectorSet.item);

      if (productContainer) {
        return productContainer;
      }

      return link.closest('form, li, article, .product-item, .product, .card, [data-product-id]') || link.parentElement;
    };
    const getCandidateItems = () => {
      const items = Array.from(document.querySelectorAll(selectorSet.item));

      if (items.length > 0) {
        return items;
      }

      const seen = new Set();
      return Array.from(document.querySelectorAll(selectorSet.link))
        .filter((link) => isProductUrl(absoluteUrl(link.getAttribute('href') || '')))
        .map(findContainerForLink)
        .filter((item) => {
          if (!item || seen.has(item)) {
            return false;
          }

          seen.add(item);
          return true;
        });
    };

    return getCandidateItems()
      .map((item) => {
        const link = item.querySelector(selectorSet.link);
        const imageElement = item.querySelector(selectorSet.image);
        const name = findProductName(item, link, imageElement);
        const productUrl = absoluteUrl(link?.getAttribute('href') || '');
        const price = findProductPrice(item);
        const image = findProductImage(item);

        if (!isProductUrl(productUrl)) {
          return null;
        }

        if (!name && !productUrl && !price && !image) {
          return null;
        }

        return {
          image,
          name,
          product_url: productUrl,
          price,
          sku: findProductSku(item),
        };
      })
      .filter(Boolean);
  }, selectors);
}

async function getNextPageUrl(page, seenPageUrls) {
  const selectors = NEXT_PAGE_SELECTORS.join(', ');
  const nextPageUrl = await page.evaluate((selector) => {
    const link = Array.from(document.querySelectorAll(selector))
      .find((element) => {
        const ariaDisabled = element.getAttribute('aria-disabled');
        const disabled = element.classList.contains('disabled');
        const parentDisabled = element.closest('li')?.classList.contains('disabled');
        return !disabled && !parentDisabled && ariaDisabled !== 'true' && element.getAttribute('href');
      });

    if (!link) {
      return '';
    }

    try {
      return new URL(link.getAttribute('href'), window.location.href).toString();
    } catch (error) {
      return '';
    }
  }, selectors);

  if (!nextPageUrl || seenPageUrls.has(nextPageUrl)) {
    return '';
  }

  return nextPageUrl;
}

async function scrapeProducts(url) {
  const session = await createBrowserSession();
  const page = await session.context.newPage();
  const products = [];
  const seenProducts = new Set();
  const seenPageUrls = new Set();
  let currentUrl = url;
  let pageNumber = 0;

  page.setDefaultTimeout(config.requestTimeout);
  page.setDefaultNavigationTimeout(config.requestTimeout);

  try {
    while (currentUrl) {
      pageNumber++;

      if (config.maxPages > 0 && pageNumber > config.maxPages) {
        break;
      }

      seenPageUrls.add(currentUrl);
      await gotoPage(page, currentUrl);
      await autoScrollUntilStable(page);

      for (const product of await extractProductsFromCurrentPage(page)) {
        const key = product.product_url || [product.name, product.price, product.image].join('|');

        if (seenProducts.has(key)) {
          continue;
        }

        seenProducts.add(key);
        products.push(product);
      }

      currentUrl = await getNextPageUrl(page, seenPageUrls);
    }

    return products;
  } finally {
    await session.close().catch((error) => {
      console.error(`Playwright close failed: ${error.message}`);
    });
  }
}

async function getProduct(request, response) {
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
  });
});

app.get('/getProduct', getProduct);

const server = app
  .listen(PORT, () => {
    console.log(`PhoneLCDParts scraper running at http://localhost:${PORT}`);
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

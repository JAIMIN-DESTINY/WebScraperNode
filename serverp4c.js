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

const PORT = readPositiveInt('PORT', 3003);
const TARGET_URL = 'https://parts4cells.com/';

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

async function scrapeCategories() {
  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  try {
    // Use 'domcontentloaded' to avoid waiting forever for network to go idle.
    // A generous timeout handles slow connections without failing prematurely.
    await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for the nav element to appear in the DOM (up to 15 s).
    // This covers sites that inject the menu via JavaScript after load.
    const NAV_SELECTOR = 'nav, .navigation, [role="navigation"], header .menu, #nav';
    await page.waitForSelector(NAV_SELECTOR, { timeout: 15000 });

    // Give any remaining JS-rendered menu items a moment to render.
    await page.waitForTimeout(1500);

    // Extract every unique anchor inside the navigation.
    const categories = await page.evaluate(() => {
      const seen = new Set();
      const results = [];

      // Only select links with the sub-category-link class
      const links = document.querySelectorAll('a.sub-category-link');

      links.forEach(link => {
        // Ignore links that have 'level0' and 'dropdown-toggle' classes
        if (link.classList.contains('level0') && link.classList.contains('dropdown-toggle')) {
          return;
        }

        const text = link.textContent.trim();
        const href = link.href;
        if (text && href && !seen.has(text)) {
          seen.add(text);
          results.push({ text, url: href });
        }
      });

      return results;
    });

    return { executablePath, categories };
  } finally {
    await browser.close();
  }
}

async function scrapeProducts(categoryUrl) {
  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  try {
    await page.goto(categoryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for at least one product card to appear before doing anything else.
    await page.waitForSelector(
      '.product-item, .product-items .item, [data-role="product-item"], li.item.product',
      { timeout: 20000 }
    );

    // ── Read the expected total product count ──────────────────────────────
    const expectedTotal = await page.evaluate(() => {
      const el = document.querySelector('.catalog-product-count');
      if (!el) return null;
      // The element may contain text like "48 Products" or just "48"
      const match = el.textContent.trim().match(/\d+/);
      return match ? parseInt(match[0], 10) : null;
    });

    console.log(`[scrapeProducts] Expected total from .catalog-product-count: ${expectedTotal}`);

    // ── Helpers ───────────────────────────────────────────────────────────
    const seen = new Map(); // key: product_url → product object

    const collectVisible = async () => {
      return page.evaluate(() => {
        const items = [];
        const cards = document.querySelectorAll(
          'li.item.product.product-item, .product-item, [data-role="product-item"]'
        );

        cards.forEach(card => {
          // name
          const nameEl =
            card.querySelector('.product-item-name a') ||
            card.querySelector('.product-item-link') ||
            card.querySelector('a.product-item-name') ||
            card.querySelector('[data-ui-id="product-name"] a') ||
            card.querySelector('.product-name a');
          const name = nameEl ? nameEl.textContent.trim() : '';

          // product_url
          const product_url = nameEl
            ? nameEl.href
            : (card.querySelector('a') || {}).href || '';

          // image — prefer data-src (lazy placeholder) then src
          const imgEl =
            card.querySelector('.product-image-photo') ||
            card.querySelector('img.product-image') ||
            card.querySelector('.product-item-photo img') ||
            card.querySelector('img');
          const image = imgEl
            ? imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || ''
            : '';

          // price
          const priceEl =
            card.querySelector('.price-box .price') ||
            card.querySelector('[data-price-type="finalPrice"] .price') ||
            card.querySelector('.price');
          const price = priceEl ? priceEl.textContent.trim() : '';

          // sku — data attribute first, then hidden element, then URL slug
          const sku =
            card.getAttribute('data-sku') ||
            (card.querySelector('[data-sku]') || {}).dataset?.sku ||
            (card.querySelector('[data-product-sku]') || {}).dataset?.productSku ||
            (card.querySelector('.product-sku') || {}).textContent?.trim() ||
            (product_url
              ? decodeURIComponent(product_url.split('/').pop().replace('.html', ''))
              : '');

          if (product_url) {
            items.push({ name, product_url, image, price, sku });
          }
        });

        return items;
      });
    };

    // Wait for any Magento loading spinner to clear
    const waitForSpinner = async () => {
      try {
        await page.waitForSelector(
          '.loading-mask, .ajax-loading, [data-role="spinner"]',
          { state: 'hidden', timeout: 8000 }
        );
      } catch {
        // spinner may not exist on this page — safe to ignore
      }
    };

    // Scroll the page gradually toward the bottom in small steps so that
    // intersection-observer–based lazy loaders trigger reliably.
    const scrollDown = async () => {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          const distance = 400;          // px per step
          const delay = 120;          // ms between steps
          const timer = setInterval(() => {
            const before = window.scrollY;
            window.scrollBy(0, distance);
            // stop stepping once we can't scroll further
            if (window.scrollY === before) {
              clearInterval(timer);
              resolve();
            }
          }, delay);
        });
      });
    };

    // ── Scroll-and-collect loop ────────────────────────────────────────────
    // Tuning constants
    const INITIAL_WAIT_MS = 3000;  // wait after first load before scrolling
    const SCROLL_WAIT_MS = 3500;  // wait after each scroll for new products
    const RETRY_WAIT_MS = 5000;  // extra wait when count hasn't changed
    const MAX_EMPTY_RETRIES = 8;     // retries before giving up (slow site tolerance)

    // Seed with products already visible on load
    await page.waitForTimeout(INITIAL_WAIT_MS);
    (await collectVisible()).forEach(p => {
      if (!seen.has(p.product_url)) seen.set(p.product_url, p);
    });
    console.log(`[scrapeProducts] Initial collect: ${seen.size} / ${expectedTotal ?? '?'}`);

    let emptyRetries = 0;

    while (true) {
      // Done?
      if (expectedTotal !== null && seen.size >= expectedTotal) {
        console.log(`[scrapeProducts] Reached expectedTotal (${expectedTotal}). Done.`);
        break;
      }

      const countBefore = seen.size;

      // Scroll gradually to bottom
      await scrollDown();

      // Wait for lazy-loaded batches and spinner
      await page.waitForTimeout(SCROLL_WAIT_MS);
      await waitForSpinner();

      // Extra pause when the site is being particularly slow
      await page.waitForTimeout(1000);

      // Collect everything now visible
      (await collectVisible()).forEach(p => {
        if (!seen.has(p.product_url)) seen.set(p.product_url, p);
      });

      const countAfter = seen.size;

      if (countAfter > countBefore) {
        // Progress — reset retry counter
        emptyRetries = 0;
        console.log(`[scrapeProducts] +${countAfter - countBefore} products → ${countAfter} / ${expectedTotal ?? '?'}`);
      } else {
        emptyRetries++;
        console.log(`[scrapeProducts] No new products (retry ${emptyRetries}/${MAX_EMPTY_RETRIES}), waiting ${RETRY_WAIT_MS}ms…`);

        if (emptyRetries >= MAX_EMPTY_RETRIES) {
          console.log(`[scrapeProducts] Giving up after ${MAX_EMPTY_RETRIES} empty retries. Final: ${seen.size} products.`);
          break;
        }

        // Longer pause before retrying — give the slow server more time
        await page.waitForTimeout(RETRY_WAIT_MS);
      }
    }

    const products = Array.from(seen.values());
    return { executablePath, expectedTotal, products };
  } finally {
    await browser.close();
  }
}

app.get('/', (request, response) => {
  response.json({
    status: 'running',
    openUrl: `http://localhost:${PORT}/getCategory`,
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
      example: `/getProduct?url=https://parts4cells.com/apple/iphone/iphone-17-air.html`,
    });
  }

  try {
    const { executablePath, expectedTotal, products } = await scrapeProducts(categoryUrl);

    response.json({
      success: true,
      url: categoryUrl,
      browser: executablePath,
      expectedTotal,
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
    console.log(`Parts4Cells server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/getCategory to launch ${TARGET_URL} in Chrome.`);
  })
  .on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error('Stop the existing server or run with another port, for example: PORT=3004 node serverp4c.js');
      process.exit(1);
    }

    throw error;
  });

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

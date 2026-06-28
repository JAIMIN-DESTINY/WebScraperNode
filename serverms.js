const express = require('express');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const PORT = process.env.PORT || 3001;
const TARGET_URL = 'https://www.mobilesentrix.com/';
const app = express();
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
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

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function createChromeDriver() {
  const options = new chrome.Options();
  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080',
    `--user-agent=${DESKTOP_USER_AGENT}`
  );

  if (process.env.CHROME_PATH) {
    options.setChromeBinaryPath(process.env.CHROME_PATH);
  }

  return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

async function waitForCategoryMenu(driver, timeoutMs = 60000) {
  await driver.wait(until.elementLocated(By.css('body')), 30000);
  await driver.wait(
    async () => driver.executeScript('return document.readyState;').then((state) => state === 'complete'),
    30000
  );

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of CATEGORY_MENU_LINK_SELECTORS) {
      const count = await driver.executeScript(
        'return document.querySelectorAll(arguments[0]).length;',
        selector
      );

      if (count > 0) {
        return selector;
      }
    }

    await driver.sleep(1000);
  }

  const debugInfo = await driver.executeScript(() => ({
    title: document.title,
    url: window.location.href,
    bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  }));

  throw new Error(
    `Category menu was not found. title="${debugInfo.title}" url="${debugInfo.url}" body="${debugInfo.bodyText}"`
  );
}

async function autoScrollUntilStable(driver, maxRounds = 25, waitMs = 1200) {
  let prevCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    await driver.executeScript('window.scrollTo(0, document.body.scrollHeight);');
    await driver.sleep(waitMs);

    const items = await driver.findElements(By.css('li.item'));
    const count = items.length;

    if (count === prevCount) {
      stableRounds++;

      if (stableRounds >= 5) {
        break;
      }
    } else {
      stableRounds = 0;
      prevCount = count;
    }
  }
}

function extractImgFromAttr(value) {
  if (!value) {
    return '';
  }

  return value.split(',')[0].trim().split(' ')[0].trim();
}

async function getProductDetails(productUrl, previousDriver = null) {
  if (!productUrl) {
    return {
      sku: '',
      description: '',
      driver: previousDriver,
    };
  }

  const driver = await createChromeDriver();

  try {
    await driver.get(productUrl);

    if (previousDriver) {
      await previousDriver.quit().catch(() => {});
    }

    await driver.wait(until.elementLocated(By.css('body')), 30000);
    await driver.sleep(1000);

    const details = await driver.executeScript(() => {
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

    return {
      ...details,
      driver,
    };
  } catch (error) {
    await driver.quit().catch(() => {});

    throw error;
  }
}

async function openChromeAndGetCategories() {
  const driver = await createChromeDriver();

  try {
    await driver.get(TARGET_URL);
    const mainCategorySelector = await waitForCategoryMenu(driver);

    const mainCategoryCount = await driver.executeScript(
      'return document.querySelectorAll(arguments[0]).length;',
      mainCategorySelector
    );
    const categoryGroups = [];

    for (let index = 0; index < mainCategoryCount; index++) {
      const mainCategoryLinks = await driver.findElements(By.css(mainCategorySelector));
      const mainCategoryLink = mainCategoryLinks[index];

      if (!mainCategoryLink) {
        continue;
      }

      const mainCategoryName = normalizeText(await mainCategoryLink.getText());

      await driver.executeScript('arguments[0].scrollIntoView({ block: "center" });', mainCategoryLink);

      try {
        await mainCategoryLink.click();
      } catch (error) {
        await driver.executeScript('arguments[0].click();', mainCategoryLink);
      }

      await driver.sleep(3000);

      const mainCategoryHtml = await driver.executeScript(
        'return arguments[0].closest("li").outerHTML;',
        mainCategoryLink
      );
      // console.log('Clicked main category:', mainCategoryName);
      // console.log('Clicked main category HTML:', mainCategoryHtml);

      const categories = await driver.executeScript((link) => {
        const mainCategory = link.closest('li');

        if (!mainCategory) {
          return [];
        }

        const seen = new Set();

        return Array.from(mainCategory.querySelectorAll('a[href]'))
          .map((link) => {
            const rawUrl = (link.getAttribute('href') || '').trim();
            const url = link.href;
            const image = link.querySelector('img');
            const name = (
              link.textContent ||
              link.getAttribute('aria-label') ||
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
      }, mainCategoryLink);

      categoryGroups.push({
        mainCategory: mainCategoryName,
        count: categories.length,
        categories,
      });
    }

    return categoryGroups;
  } finally {
    await driver.quit();
  }
}

async function openChromeAndGetProducts(url) {
  const driver = await createChromeDriver();
  let currentDriver = driver;
  const products = [];

  try {
    await driver.get(url);
    await driver.wait(until.elementsLocated(By.css('li.item')), 30000);
    await autoScrollUntilStable(driver);

    const items = await driver.findElements(By.css('li.item'));

    for (const item of items) {
      await driver.executeScript('arguments[0].scrollIntoView({ block: "center" });', item);
      await driver.sleep(200);

      let name = '';
      let price = '';
      let img = '';
      let productUrl = '';

      try {
        name = await item.findElement(By.css('h2.product-name')).getText();
      } catch (error) {}

      try {
        price = await item.findElement(By.css('span.regular-price')).getText();
      } catch (error) {
        try {
          price = await item.findElement(By.css('.price')).getText();
        } catch (innerError) {}
      }

      try {
        const imgElement = await item.findElement(By.css('img.small-img'));
        const attributes = ['src', 'data-src', 'srcset', 'data-lazy', 'data-original'];

        for (const attribute of attributes) {
          const value = await imgElement.getAttribute(attribute).catch(() => null);

          if (value && value.trim()) {
            img = extractImgFromAttr(value);

            if (img) {
              break;
            }
          }
        }
      } catch (error) {}

      try {
        const productLink = await item.findElement(By.css('a.product-image.figure'));
        productUrl = await productLink.getAttribute('href');
      } catch (error) {}

      if (name || price || img || productUrl) {
        products.push({
          name: normalizeText(name),
          price: normalizeText(price),
          img,
          product_url: productUrl,
          sku: '',
          description: '',
        });
      }
    }

    for (const product of products) {
      const details = await getProductDetails(product.product_url, currentDriver);
      currentDriver = details.driver || currentDriver;
      product.sku = normalizeText(details.sku);
      product.description = (details.description || '').trim();
    }

    return products;
  } finally {
    await currentDriver.quit().catch(() => {});

    if (currentDriver !== driver) {
      await driver.quit().catch(() => {});
    }
  }
}

async function openTargetUrl(request, response) {
  try {
    const categoryGroups = await openChromeAndGetCategories();
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

  if (!url) {
    return response.status(400).json({
      success: false,
      message: 'URL parameter is required.',
    });
  }

  try {
    const products = await openChromeAndGetProducts(url);

    return response.json({
      success: true,
      url,
      count: products.length,
      data: products,
    });
  } catch (error) {
    return response.status(500).json({
      success: false,
      error: error.message,
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

app.listen(PORT, () => {
  console.log(`Node server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/getCategory to launch ${TARGET_URL} in Chrome.`);
}).on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error('Stop the existing server or run with a different port, for example: PORT=3001 node serverms.js');
    process.exit(1);
  }

  throw error;
});

process.on('SIGINT', () => {
  process.exit(0);
});

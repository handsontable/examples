/* eslint-disable */
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  // Puppeteer not available (e.g., in StackBlitz WebContainers)
  console.warn('Puppeteer not available, skipping E2E tests');
}

describe('Smoke check', () => {
  let browser = null;
  let page = null;
  const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';

  beforeAll(() => {
    if (!puppeteer) {
      pending('Puppeteer not available - skipping E2E tests');
    }
  });

  beforeEach(async () => {
    if (!puppeteer) return;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 100000;
    // browser = await puppeteer.launch({ headless: false, slowMo: 250, devtools: true });
    browser = await puppeteer.launch();
    page = await browser.newPage();
    await page.goto(BASE_URL);
  }, 90000);

  afterEach(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it('should render Handsontable', async () => {
    if (!puppeteer || !page) {
      pending('Puppeteer not available');
      return;
    }
    const hotCell = await page.$('.handsontable td');

    await expect(hotCell).toBeTruthy();
  });
});

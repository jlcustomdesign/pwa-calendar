const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://localhost:4321/dashboard/calendar');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'calendar_final.png' });
  await browser.close();
})();

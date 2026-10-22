// Original synthetic content for repeatable UI checks; no third-party imagery.
import { readFile } from 'node:fs/promises';
import { launchBrowser } from '../tests/browser.mjs';
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 }, deviceScaleFactor: 1 });
  await page.setContent(await readFile('tests/fixtures/demo.html', 'utf8'));
  await page.screenshot({ path: 'tests/fixtures/demo.png' });
} finally { await browser.close(); }

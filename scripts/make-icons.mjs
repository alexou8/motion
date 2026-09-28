/**
 * Rasterizes Motion's canonical SVG mark for Chrome's action, notification,
 * and extension-management surfaces. The panel and settings page use the SVG
 * directly; Chrome's manifest still requires PNGs at these four sizes.
 *
 *   node scripts/make-icons.mjs
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../src/assets/motion-mark.svg', import.meta.url));
const imageUrl = `data:image/svg+xml;base64,${source.toString('base64')}`;
const output = new URL('../src/assets/icons/', import.meta.url);

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      img { display: block; width: 100%; height: 100%; }
    </style><img src="${imageUrl}" alt="">`);
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({ path: new URL(`icon-${size}.png`, output).pathname, omitBackground: true });
    await page.close();
    console.log(`src/assets/icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}

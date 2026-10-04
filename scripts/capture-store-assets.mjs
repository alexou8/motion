import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Listing compositions use screenshots of the built UI and synthetic LMS data. */
export async function captureStoreAssets(context, panel) {
  const output = resolve('docs/store-assets');
  await mkdir(output, { recursive: true });
  const originalViewport = panel.viewportSize();
  await panel.setViewportSize({ width: 400, height: 740 });
  await panel.getByRole('button', { name: 'List', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    const filter = panel.getByLabel('Filter by course');
    if (theme === 'dark' && (await filter.count())) await filter.selectOption('');
    await panel.emulateMedia({ colorScheme: theme });
    await panel.evaluate(async (value) => {
      document.documentElement.dataset.theme = value;
      await document.fonts.ready;
    }, theme);
    await panel.locator('main').evaluate((main) => {
      const heading = document.getElementById('deadlines-title');
      if (heading)
        main.scrollTop +=
          heading.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
    });
    const screenshot = await panel.screenshot();
    await writeFile(join(output, `panel-${theme}.png`), screenshot);
  }
  if (originalViewport) await panel.setViewportSize(originalViewport);
  await panel.emulateMedia({ colorScheme: 'light' });
  await panel.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
  await renderStoreAssets(context);
}

export async function renderStoreAssets(context) {
  const output = resolve('docs/store-assets');
  const mark = (await readFile('src/assets/brand/motion-mark.svg')).toString('base64');
  const serif = (await readFile('src/assets/fonts/source-serif-4-var.woff2')).toString('base64');
  const sans = (await readFile('src/assets/fonts/ibm-plex-sans-var.woff2')).toString('base64');
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });
  for (const theme of ['light', 'dark']) {
    const screenshot = await readFile(join(output, `panel-${theme}.png`));
    if (theme === 'light')
      await canvas.setContent(`<!doctype html><style>
      @font-face{font-family:Serif;font-display:swap;src:url(data:font/woff2;base64,${serif})}
      @font-face{font-family:Sans;font-display:swap;src:url(data:font/woff2;base64,${sans})}
      *{box-sizing:border-box}body{margin:0;background:#330072;color:#fff;font-family:Sans;display:flex;height:800px;align-items:center;gap:60px;padding:30px 70px}
      .copy{flex:1} .brand{display:flex;align-items:center;gap:12px;font:32px Serif}.brand img{width:72px}
      h1{font:54px/1.12 Serif;margin:34px 0 24px;max-width:530px}p{font-size:23px;line-height:1.5;max-width:510px;color:#e6daef}
      .gold{color:#f2a900}.note{font-size:15px;margin-top:36px}.panel{width:400px;height:740px;flex:none;border-radius:10px;overflow:hidden;box-shadow:0 16px 50px #18003370}.panel img{width:400px;height:740px;display:block}
      </style><div class="copy"><div class="brand"><img src="data:image/svg+xml;base64,${mark}" alt="">Motion</div><h1>Coursework,<br><span class="gold">in motion.</span></h1><p>Find what’s due.<br>Keep the source in sight.<br>Choose your next step.</p><p class="note">${theme === 'light' ? 'Light' : 'Dark'} mode · Synthetic coursework preview</p></div><div class="panel"><img src="data:image/png;base64,${screenshot.toString('base64')}" alt="Motion side panel"></div>`);
    else
      await canvas.evaluate(
        (src) => {
          document.querySelector('.panel img').src = src;
          document.querySelector('.note').textContent = 'Dark mode · Synthetic coursework preview';
        },
        `data:image/png;base64,${screenshot.toString('base64')}`,
      );
    await canvas.evaluate(async () => {
      await Promise.all([document.fonts.load('54px Serif'), document.fonts.load('23px Sans')]);
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    await canvas.bringToFront();
    await canvas.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    // Prime Chromium's compositor after switching tabs before saving the frame.
    await canvas.screenshot();
    await canvas.waitForTimeout(100);
    await canvas.screenshot({ path: join(output, `screenshot-${theme}.png`) });
    console.log(`Store screenshot ready: docs/store-assets/screenshot-${theme}.png`);
  }
  await canvas.close();
  const promo = await context.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  await promo.setContent(`<!doctype html><style>
    @font-face{font-family:Serif;font-display:swap;src:url(data:font/woff2;base64,${serif})}body{margin:0;background:#330072;display:flex;align-items:center;justify-content:center;gap:12px;height:280px;color:#fff;font:48px Serif}img{width:140px}
    </style><img src="data:image/svg+xml;base64,${mark}" alt="">Motion`);
  await promo.evaluate(async () => {
    await document.fonts.load('48px Serif');
    await document.fonts.ready;
    await document.images[0].decode();
  });
  await promo.bringToFront();
  await promo.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await promo.screenshot({ path: join(output, 'promo-440x280.png') });
  await promo.close();
}

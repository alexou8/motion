import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const output = resolve('.motion-site');
const policy = await readFile('docs/PRIVACY.md', 'utf8');
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = (value) => escape(value).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
  if (!url.startsWith('https://') && !url.startsWith('mailto:')) throw new Error('Unsupported policy link.');
  return `<a href="${url}">${label}</a>`;
});
const sections = [];
const body = policy.trim().split(/\n\s*\n/).map((block) => {
  if (block.startsWith('# ')) return '<h1>Privacy policy</h1>';
  if (block.startsWith('## ')) {
    const label = block.slice(3).trim();
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    sections.push({ label, id });
    return `<h2 id="${id}">${escape(label)}</h2>`;
  }
  if (block.startsWith('Last updated: ')) return `<p class="updated">${escape(block)}</p>`;
  // The policy source intentionally uses only headings, paragraphs and links.
  // Refuse richer Markdown rather than silently dropping future disclosures.
  if (/^\s*(?:[#>*-]|\d+\.|```)/m.test(block)) throw new Error('Unsupported policy Markdown.');
  return `<p>${inline(block.replaceAll('\n', ' '))}</p>`;
}).join('\n');
const toc = sections.map(({ label, id }) => `<li><a href="#${id}">${escape(label)}</a></li>`).join('\n');
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="How Motion handles coursework, local storage, optional AI providers, and deletion. Published by Alex Ou.">
  <title>Privacy policy · Motion</title>
  <link rel="icon" type="image/png" href="assets/icon-32.png">
  <link rel="stylesheet" href="site.css">
</head>
<body>
  <a class="skip" href="#policy">Skip to privacy policy</a>
  <header><a class="brand" href="index.html"><img src="assets/motion-mark.svg" alt="" width="40" height="40">Motion</a><a href="https://github.com/alexou8/motion/issues">Support</a></header>
  <div class="layout">
    <nav aria-label="Policy sections"><p>On this page</p><ul>${toc}</ul></nav>
    <main id="policy" tabindex="-1">${body}</main>
  </div>
  <footer><p>Motion · Published by Alex Ou</p><a href="mailto:alexoudev8@gmail.com">Privacy questions</a><a href="https://github.com/alexou8/motion">Project source</a></footer>
</body>
</html>
`;
await mkdir(join(output, 'assets'), { recursive: true });
for (const name of ['index.html', 'privacy.html', '404.html']) await writeFile(join(output, name), html);
await writeFile(join(output, '.nojekyll'), '');
await copyFile('docs/PRIVACY.md', join(output, 'privacy.md'));
await copyFile('website/site.css', join(output, 'site.css'));
await copyFile('src/assets/brand/motion-mark.svg', join(output, 'assets/motion-mark.svg'));
await copyFile('src/assets/icons/icon-32.png', join(output, 'assets/icon-32.png'));
await copyFile('src/assets/fonts/ibm-plex-sans-var.woff2', join(output, 'assets/ibm-plex-sans.woff2'));
await copyFile('src/assets/fonts/source-serif-4-var.woff2', join(output, 'assets/source-serif.woff2'));
await mkdir(join(output, 'licenses'), { recursive: true });
await copyFile('src/assets/fonts/OFL-ibm-plex.txt', join(output, 'licenses/ibm-plex.txt'));
await copyFile('src/assets/fonts/OFL-source-serif-4.txt', join(output, 'licenses/source-serif-4.txt'));
console.log(`Built public privacy policy from docs/PRIVACY.md in ${output}`);

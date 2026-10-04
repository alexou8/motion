import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';

const permissions = ['storage', 'sidePanel', 'tabs', 'tabGroups', 'alarms', 'notifications'];
const hosts = [
  'https://*.brightspace.com/*',
  'https://*.desire2learn.com/*',
  'https://mylearningspace.wlu.ca/*',
];

/** Fail closed before uploading an accidentally repackaged development build. */
export function verifyStorePackage(directory, version) {
  const root = resolve(directory);
  const file = (path) => {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\'))
      throw new Error('Invalid package path.');
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === '..' || !rel)
      throw new Error('Package path escapes its root.');
    return readFileSync(absolute);
  };
  const manifest = JSON.parse(file('manifest.json'));
  const sameSet = (actual, expected) =>
    Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  if (manifest.manifest_version !== 3) throw new Error('Store package must use Manifest V3.');
  if (manifest.version !== version) throw new Error('Package and manifest versions differ.');
  if (
    typeof manifest.minimum_chrome_version !== 'string' ||
    !/^\d+(?:\.\d+){0,3}$/.test(manifest.minimum_chrome_version) ||
    Number(manifest.minimum_chrome_version.split('.')[0]) < 116
  ) {
    throw new Error('Store package must require Chrome 116 or newer for sidePanel.open.');
  }
  if (manifest.background?.type !== 'module')
    throw new Error('Store service worker must use ES modules.');
  if (
    !manifest.name ||
    manifest.name.length > 75 ||
    !manifest.description ||
    manifest.description.length > 132
  ) {
    throw new Error('Store name or description exceeds Chrome limits.');
  }
  if (
    !sameSet(manifest.permissions, permissions) ||
    !sameSet(manifest.optional_permissions, ['nativeMessaging'])
  ) {
    throw new Error('Unexpected permissions: test build or unreviewed permission change.');
  }
  if (
    !sameSet(manifest.host_permissions, hosts) ||
    !sameSet(manifest.optional_host_permissions, [
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
    ])
  ) {
    throw new Error('Unexpected hosts: test build or unreviewed host change.');
  }
  for (const path of [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.options_page,
    manifest.action?.default_popup,
  ])
    file(path);
  for (const script of manifest.content_scripts ?? []) {
    if (!sameSet(script.matches, hosts)) throw new Error('Unexpected content-script hosts.');
    for (const path of [...(script.js ?? []), ...(script.css ?? [])]) file(path);
  }
  for (const [size, path] of [
    ...Object.entries(manifest.icons ?? {}),
    ...Object.entries(manifest.action?.default_icon ?? {}),
  ]) {
    const png = file(path);
    if (
      png.length < 24 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(16) !== Number(size) ||
      png.readUInt32BE(20) !== Number(size)
    ) {
      throw new Error(`Icon ${size} is not a PNG at the declared dimensions.`);
    }
  }
  if (!manifest.icons?.['128']) throw new Error('Missing 128px store icon.');
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("script-src 'self';") || /unsafe-eval|https?:/.test(csp))
    throw new Error('Unsafe extension CSP.');
  if (manifest.externally_connectable) throw new Error('Unexpected external messaging.');
  for (const entry of manifest.web_accessible_resources ?? []) {
    if (entry.resources.some((path) => /\.html?$|\*/i.test(path)))
      throw new Error('Extension UI must not be web-accessible.');
    if (!sameSet(entry.matches, hosts))
      throw new Error('Unexpected web-accessible resource hosts.');
    for (const path of entry.resources) file(path);
  }
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const rel = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in a store package.');
      if (
        /(^|[/\\])(?:node_modules|\.git|fixtures|test|tests)([/\\]|$)|\.map$|\.env|\.DS_Store|\.(?:test|spec)\.|vite\/client/i.test(
          rel,
        )
      ) {
        throw new Error(`Development file in store package: ${rel}`);
      }
      if (stat.isDirectory()) walk(path);
      else if (/\.(?:html|js)$/.test(path)) {
        const source = readFileSync(path, 'utf8');
        if (/localhost|127\.0\.0\.1|@vite\/client|react-refresh/.test(source))
          throw new Error(`Development runtime in ${rel}`);
        if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source))
          throw new Error(`Dynamic code execution in ${rel}`);
        if (
          /\.html$/.test(path) &&
          /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:|\/\/)/i.test(source)
        ) {
          throw new Error(`Remote script in ${rel}`);
        }
      }
    }
  }
  walk(root);
  const notices = file('THIRD_PARTY_NOTICES.txt').toString();
  if (
    !notices.includes('SIL OPEN FONT LICENSE') ||
    !['React', 'Scheduler', 'Zod', 'clsx', 'tailwind-merge', 'fflate', 'PDF.js', 'core-js'].every(
      (name) => notices.includes(name),
    ) ||
    !notices.includes('Apache License') ||
    !notices.includes('Denis Pushkarev')
  )
    throw new Error('Missing bundled licenses.');
  return manifest;
}

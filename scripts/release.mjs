/** Validate production release inputs and prepare assets from the tested build. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExtensionArchive, extensionFiles } from './package.mjs';

export function validateVersion(version) {
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split('.').some((part) => Number(part) > 65535) ||
    version === '0.0.0'
  ) {
    throw new Error('Release version must be a valid three-part Chrome version.');
  }
  return version;
}

export function releaseMetadata(root = '.', tag = '') {
  const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const version = validateVersion(readJson('package.json').version);
  const lock = readJson('package-lock.json');
  const manifest = readJson('dist/manifest.json');
  if (
    lock.version !== version ||
    lock.packages?.['']?.version !== version ||
    manifest.version !== version
  ) {
    throw new Error(
      'package.json, package-lock.json and the built manifest must have the same version.',
    );
  }
  if (tag && tag !== `v${version}`)
    throw new Error(`Release tag must be v${version}; received ${tag}.`);
  if (manifest.manifest_version !== 3) throw new Error('Only Manifest V3 builds can be released.');
  if (
    typeof manifest.minimum_chrome_version !== 'string' ||
    !/^\d+(?:\.\d+){0,3}$/.test(manifest.minimum_chrome_version)
  ) {
    throw new Error('The build must declare a valid minimum Chrome version.');
  }
  const productionHosts = [
    'https://*.brightspace.com/*',
    'https://*.desire2learn.com/*',
    'https://mylearningspace.wlu.ca/*',
  ];
  if (
    (manifest.permissions ?? []).includes('nativeMessaging') ||
    !Array.isArray(manifest.host_permissions) ||
    JSON.stringify([...manifest.host_permissions].sort()) !== JSON.stringify(productionHosts.sort())
  ) {
    throw new Error('Test-only provider or keychain permissions cannot be released.');
  }

  const dist = join(root, 'dist');
  const files = extensionFiles(dist).map((file) => relative(dist, file).split(sep).join('/'));
  if (
    files.some((name) => /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules)(?:\/|$)|\.map$/.test(name))
  ) {
    throw new Error('Build contains development files, source maps or private configuration.');
  }
  const references = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap((script) => [
      ...(script.js ?? []),
      ...(script.css ?? []),
    ]),
    ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
  ].filter((path) => path !== undefined);
  for (const path of references) {
    if (
      typeof path !== 'string' ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => part === '..' || part === '.') ||
      /[\r\n\x00]/.test(path)
    ) {
      throw new Error('Manifest contains an unsafe file reference.');
    }
    const pattern = new RegExp(
      `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`,
    );
    if (!files.some((name) => pattern.test(name)))
      throw new Error(`Manifest references a missing file: ${path}`);
  }
  for (const required of ['background', 'side_panel', 'action']) {
    if (!manifest[required]) throw new Error(`The Motion build is missing ${required}.`);
  }
  if (
    !manifest.background.service_worker ||
    !manifest.side_panel.default_path ||
    !manifest.action.default_popup ||
    !manifest.options_page
  ) {
    throw new Error('The Motion build must include its worker, launcher, side panel and settings.');
  }
  return { version, minimumChrome: manifest.minimum_chrome_version };
}

export function writeChecksums(directory, names) {
  const lines = names.map((name) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Unsafe release asset name.');
    return `${createHash('sha256')
      .update(readFileSync(join(directory, name)))
      .digest('hex')}  ${name}`;
  });
  writeFileSync(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

export function prepareRelease({ root = '.', tag = '', sha, output = '.motion-release' }) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('Release source must be a full commit SHA.');
  const metadata = releaseMetadata(root, tag);
  const extension = `motion-extension-${metadata.version}.zip`;
  const companion = `motion-keychain-companion-${metadata.version}.zip`;
  if (!readFileSync(join(root, extension)).equals(createExtensionArchive(join(root, 'dist')))) {
    throw new Error('Extension archive does not exactly match the validated build.');
  }
  const directory = resolve(root, output);
  mkdirSync(directory, { recursive: true });
  for (const name of [extension, companion]) copyFileSync(join(root, name), join(directory, name));
  const release = { ...metadata, sha, extension, companion };
  writeFileSync(join(directory, 'motion-release.json'), `${JSON.stringify(release, null, 2)}\n`);
  writeChecksums(directory, [extension, companion, 'motion-release.json']);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = prepareRelease({
      tag: process.env.MOTION_RELEASE_TAG ?? '',
      sha: process.env.GITHUB_SHA,
    });
    console.log(`Validated release assets for Motion ${result.version} at ${result.sha}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

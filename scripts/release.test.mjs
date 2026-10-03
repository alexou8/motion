// All release inputs and repository state below are synthetic.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageExtension } from './package.mjs';
import { prepareRelease, releaseMetadata, validateVersion, writeChecksums } from './release.mjs';
import { publishRelease } from './publish-release.mjs';

const SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'motion-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist'));
  const manifest = {
    manifest_version: 3,
    version: '0.1.1',
    minimum_chrome_version: '116',
    background: { service_worker: 'worker.js' },
    side_panel: { default_path: 'panel.html' },
    action: { default_popup: 'popup.html', default_icon: { 16: 'icon.png' } },
    options_page: 'options.html',
    icons: { 16: 'icon.png' },
    content_scripts: [{ js: ['content.js'], css: ['style.css'] }],
    web_accessible_resources: [
      { resources: ['assets/*.js'], matches: ['https://example.invalid/*'] },
    ],
    permissions: ['storage'],
    host_permissions: [
      'https://*.brightspace.com/*',
      'https://*.desire2learn.com/*',
      'https://mylearningspace.wlu.ca/*',
    ],
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }));
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ version: '0.1.1', packages: { '': { version: '0.1.1' } } }),
  );
  writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify(manifest));
  for (const name of [
    'worker.js',
    'panel.html',
    'popup.html',
    'options.html',
    'icon.png',
    'content.js',
    'style.css',
  ]) {
    writeFileSync(join(root, 'dist', name), 'Synthetic build file.');
  }
  mkdirSync(join(root, 'dist/assets'));
  writeFileSync(join(root, 'dist/assets/shared.js'), 'Synthetic asset.');
  packageExtension(root);
  writeFileSync(join(root, 'motion-keychain-companion-0.1.1.zip'), 'Synthetic companion bytes.');
  const directory = join(root, '.motion-release');
  prepareRelease({ root, tag: 'v0.1.1', sha: SHA });
  return {
    root,
    directory,
    manifest,
    saveManifest: () => writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify(manifest)),
  };
}

function repositoryState({
  main = SHA,
  existing = null,
  latest = null,
  uploadFails = false,
  annotated = false,
} = {}) {
  const state = {
    main,
    tag: SHA,
    release: existing && { ...existing },
    latest,
    files: new Map(),
    writes: 0,
  };
  const missing = () => {
    throw Object.assign(new Error('Not found'), { stderr: 'gh: Not Found (HTTP 404)' });
  };
  const run = (args) => {
    if (args[0] === 'api') {
      const path = args[1].replace('repos/synthetic/motion/', '');
      if (args.includes('--method')) {
        state.writes++;
        state.tag = args.find((arg) => arg.startsWith('sha=')).slice(4);
        return '{}';
      }
      if (path === 'git/ref/heads/main')
        return JSON.stringify({ object: { type: 'commit', sha: state.main } });
      if (path.startsWith('git/ref/tags/'))
        return JSON.stringify({ object: { type: annotated ? 'tag' : 'commit', sha: state.tag } });
      if (path.startsWith('git/tags/'))
        return JSON.stringify({ object: { type: 'commit', sha: SHA } });
      if (path === 'releases/latest')
        return state.latest ? JSON.stringify({ tag_name: state.latest }) : missing();
      if (path.startsWith('releases/tags/'))
        return state.release ? JSON.stringify(state.release) : missing();
      throw new Error(`Unexpected API path: ${path}`);
    }
    state.writes++;
    if (args[1] === 'create') state.release = { draft: true, immutable: false };
    if (args[1] === 'upload') {
      if (uploadFails) throw new Error('Synthetic upload failure');
      for (const path of args.filter(
        (arg) => arg.endsWith('.zip') || arg.endsWith('.json') || arg.endsWith('SHA256SUMS'),
      )) {
        state.files.set(path.split('/').at(-1), readFileSync(path));
      }
    }
    if (args[1] === 'edit') {
      if (args.includes('--draft=true')) state.release.draft = true;
      if (args.includes('--draft=false')) state.release.draft = false;
      if (args.includes('--latest=true')) state.latest = args[2];
    }
    return '';
  };
  return { state, run };
}

const publish = (directory, run, extra = {}) =>
  publishRelease({
    channel: 'version',
    tag: 'v0.1.1',
    sha: SHA,
    repository: 'synthetic/motion',
    directory,
    run,
    ...extra,
  });

test('release assets contain verified build bytes, checksums and source provenance', (t) => {
  const { root, directory } = fixture(t);
  const metadata = JSON.parse(readFileSync(join(directory, 'motion-release.json')));
  assert.equal(metadata.sha, SHA);
  assert.deepEqual(
    readFileSync(join(directory, metadata.extension)),
    readFileSync(join(root, metadata.extension)),
  );
  assert.match(
    readFileSync(join(directory, 'SHA256SUMS'), 'utf8'),
    /^[a-f0-9]{64}  motion-extension-0\.1\.1\.zip\n/,
  );
});

test('version and tag drift stop release preparation', (t) => {
  const { root, manifest, saveManifest } = fixture(t);
  assert.throws(() => releaseMetadata(root, 'v0.1.2'), /Release tag must be v0.1.1/);
  manifest.version = '0.1.2';
  saveManifest();
  assert.throws(() => releaseMetadata(root), /same version/);
  for (const version of ['0.0.0', '01.1.1', '1.2.3-beta', '65536.1.1', '../1.2.3']) {
    assert.throws(() => validateVersion(version), /valid three-part Chrome version/);
  }
});

test('missing launcher icons, content CSS and unsafe file references stop preparation', (t) => {
  const { root, manifest, saveManifest } = fixture(t);
  manifest.action.default_icon[16] = 'missing.png';
  saveManifest();
  assert.throws(() => releaseMetadata(root), /missing file: missing.png/);
  manifest.action.default_icon[16] = 'icon.png';
  manifest.content_scripts[0].css = ['missing.css'];
  saveManifest();
  assert.throws(() => releaseMetadata(root), /missing file: missing.css/);
  manifest.content_scripts[0].css = ['../private.css'];
  saveManifest();
  assert.throws(() => releaseMetadata(root), /unsafe file reference/);
});

test('test-only permissions, source maps and stale archives cannot ship', (t) => {
  const { root, manifest, saveManifest } = fixture(t);
  manifest.host_permissions.push('http://127.0.0.1:8934/*');
  saveManifest();
  assert.throws(() => releaseMetadata(root), /Test-only/);
  manifest.host_permissions.pop();
  manifest.host_permissions.push('https://api.openai.com/*');
  saveManifest();
  assert.throws(() => releaseMetadata(root), /Test-only/);
  manifest.host_permissions.pop();
  manifest.permissions.push('nativeMessaging');
  saveManifest();
  assert.throws(() => releaseMetadata(root), /Test-only/);
  manifest.permissions.pop();
  saveManifest();
  writeFileSync(join(root, 'dist/private.map'), 'Synthetic source map.');
  assert.throws(() => releaseMetadata(root), /development files/);
  rmSync(join(root, 'dist/private.map'));
  writeFileSync(join(root, 'dist/worker.js'), 'Changed synthetic build.');
  assert.throws(() => prepareRelease({ root, sha: SHA }), /exactly match/);
});

test('version release publishes the validated files and resolves annotated tags', (t) => {
  const { directory } = fixture(t);
  const { state, run } = repositoryState({ annotated: true });
  assert.deepEqual(publish(directory, run), { skipped: false, tag: 'v0.1.1', latest: true });
  assert.equal(state.release.draft, false);
  assert.equal(state.latest, 'v0.1.1');
  assert.deepEqual(
    [...state.files.keys()],
    [
      'motion-extension-0.1.1.zip',
      'motion-keychain-companion-0.1.1.zip',
      'motion-release.json',
      'SHA256SUMS',
    ],
  );
});

test('published versioned assets are never replaced and immutable main builds are refused', (t) => {
  const { directory } = fixture(t);
  for (const options of [
    { existing: { draft: false, immutable: false } },
    { existing: { draft: true, immutable: true } },
  ]) {
    const { state, run } = repositoryState(options);
    assert.throws(() => publish(directory, run), /will not be replaced/);
    assert.equal(state.writes, 0);
  }
  const { state, run } = repositoryState({ existing: { draft: false, immutable: true } });
  assert.throws(() => publish(directory, run, { channel: 'main' }), /immutable/);
  assert.equal(state.writes, 0);
});

test('failed uploads leave a draft; reruns can finish that draft', (t) => {
  const { directory } = fixture(t);
  const failed = repositoryState({ uploadFails: true });
  assert.throws(() => publish(directory, failed.run), /upload failure/);
  assert.equal(failed.state.release.draft, true);
  const retry = repositoryState({ existing: failed.state.release });
  publish(directory, retry.run);
  assert.equal(retry.state.release.draft, false);
});

test('older version tags do not displace a newer Latest release', (t) => {
  const { directory } = fixture(t);
  const { state, run } = repositoryState({ latest: 'v0.2.0' });
  assert.equal(publish(directory, run).latest, false);
  assert.equal(state.latest, 'v0.2.0');
});

test('stale main builds are skipped and valid main builds use stable prerelease asset names', (t) => {
  const { directory } = fixture(t);
  const stale = repositoryState({ main: NEXT_SHA });
  assert.deepEqual(publish(directory, stale.run, { channel: 'main' }), { skipped: true });
  assert.equal(stale.state.writes, 0);
  const current = repositoryState({
    existing: { draft: false, immutable: false },
    latest: 'v0.1.0',
  });
  const result = publish(directory, current.run, { channel: 'main' });
  assert.equal(result.tag, 'main-build');
  assert.equal(current.state.release.draft, false);
  assert.equal(current.state.latest, 'v0.1.0');
  assert.equal(current.state.files.has('motion-extension-latest.zip'), true);
  assert.equal(JSON.parse(current.state.files.get('motion-release.json')).sha, SHA);
});

test('artifact tampering, wrong source commits and API failures stop before release writes', (t) => {
  const { directory } = fixture(t);
  const { state, run } = repositoryState();
  assert.throws(() => publish(directory, run, { sha: NEXT_SHA }), /metadata does not match/);
  const error = Object.assign(new Error('Synthetic permission failure'), {
    stderr: 'gh: Forbidden (HTTP 403)',
  });
  assert.throws(
    () =>
      publish(directory, () => {
        throw error;
      }),
    /permission failure/,
  );
  writeFileSync(join(directory, 'motion-extension-0.1.1.zip'), 'Tampered synthetic artifact.');
  assert.throws(() => publish(directory, run), /checksum verification failed/);
  assert.equal(state.writes, 0);
});

test('checksum manifests reject filenames that could create extra lines or traverse paths', (t) => {
  const { directory } = fixture(t);
  assert.throws(() => writeChecksums(directory, ['../private.zip']), /Unsafe release asset name/);
  assert.throws(() => writeChecksums(directory, ['file\nname.zip']), /Unsafe release asset name/);
});

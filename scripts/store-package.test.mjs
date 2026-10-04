import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyStorePackage } from './store-package.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

test('accepts the production build', () => {
  assert.equal(verifyStorePackage('dist', version).version, version);
});

for (const [name, mutate, error] of [
  [
    'test provider host',
    (dir, m) => {
      m.host_permissions.push('http://127.0.0.1:8934/*');
    },
    /Unexpected hosts/,
  ],
  [
    'required native messaging',
    (dir, m) => {
      m.permissions.push('nativeMessaging');
    },
    /Unexpected permissions/,
  ],
  [
    'broad optional provider hosts',
    (dir, m) => {
      m.optional_host_permissions = ['https://*/*'];
    },
    /Unexpected hosts/,
  ],
  [
    'unsupported Chrome version',
    (dir, m) => {
      m.minimum_chrome_version = '115';
    },
    /Chrome 116/,
  ],
  [
    'missing Chrome version',
    (dir, m) => {
      delete m.minimum_chrome_version;
    },
    /Chrome 116/,
  ],
  [
    'classic service worker',
    (dir, m) => {
      delete m.background.type;
    },
    /ES modules/,
  ],
  [
    'unused scripting',
    (dir, m) => {
      m.permissions.push('scripting');
    },
    /Unexpected permissions/,
  ],
  [
    'oversized description',
    (dir, m) => {
      m.description = 'x'.repeat(133);
    },
    /Chrome limits/,
  ],
  [
    'missing icon',
    (dir, m) => {
      rmSync(join(dir, m.icons['128']));
    },
    /ENOENT/,
  ],
  [
    'wrong icon size',
    (dir, m) => {
      m.icons['128'] = m.icons['16'];
    },
    /dimensions/,
  ],
  [
    'fixture file',
    (dir) => {
      writeFileSync(join(dir, 'example.test.js'), 'synthetic fixture');
    },
    /Development file/,
  ],
  [
    'source map',
    (dir) => {
      writeFileSync(join(dir, 'bundle.js.map'), '{}');
    },
    /Development file/,
  ],
  [
    'development runtime',
    (dir) => {
      writeFileSync(join(dir, 'bad.js'), 'import "http://localhost:5173/@vite/client";');
    },
    /Development runtime/,
  ],
  [
    'dynamic execution',
    (dir) => {
      writeFileSync(join(dir, 'bad.js'), 'new Function("return 1")();');
    },
    /Dynamic code/,
  ],
  [
    'web-accessible UI',
    (dir, m) => {
      m.web_accessible_resources = [
        { resources: ['src/options/index.html'], matches: ['https://*/*'] },
      ];
    },
    /web-accessible/,
  ],
  [
    'missing web-accessible chunk',
    (dir, m) => {
      m.web_accessible_resources[0].resources.push('assets/missing.js');
    },
    /ENOENT/,
  ],
  [
    'web-accessible chunks on every site',
    (dir, m) => {
      m.web_accessible_resources[0].matches = ['https://*/*'];
    },
    /resource hosts/,
  ],
  [
    'incomplete runtime notices',
    (dir) => {
      writeFileSync(join(dir, 'THIRD_PARTY_NOTICES.txt'), 'SIL OPEN FONT LICENSE\nReact');
    },
    /Missing bundled licenses/,
  ],
  [
    'path traversal',
    (dir, m) => {
      m.side_panel.default_path = '../outside.html';
    },
    /escapes/,
  ],
]) {
  test(`rejects ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'motion-package-'));
    try {
      cpSync('dist', dir, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      mutate(dir, manifest);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      assert.throws(() => verifyStorePackage(dir, version), error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Synthetic manifest tampering must be refused by the actual upload CLI.
test('packaging CLI refuses a test build before writing an archive', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'motion-package-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  cpSync('dist', dist, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1:8934/*');
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [resolve('scripts/package.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected hosts/);
  assert.throws(() => readFileSync(join(root, `motion-extension-${version}.zip`)), /ENOENT/);
});

// Synthetic injected modules prove the browser-independent worker check follows
// imports instead of checking only the entry bundle.
test('build verification rejects DOM globals in a worker dependency', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'motion-worker-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  cpSync('dist', dist, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  const loader = join(dist, manifest.background.service_worker);
  writeFileSync(loader, `${readFileSync(loader, 'utf8')}\nimport './synthetic-shared.js';`);
  writeFileSync(join(dist, 'synthetic-shared.js'), 'document.title = "Synthetic fixture";');
  const result = spawnSync(process.execPath, [resolve('scripts/verify-extension-build.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic-shared\.js contains DOM globals/);
});

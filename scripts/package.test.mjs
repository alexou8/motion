// All build content in this file is synthetic; no student or course data is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExtensionArchive } from './package.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'motion-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'manifest.json'), '{"manifest_version":3,"version":"0.1.1"}');
  return { root, dist };
}

test('ZIP extracts with standard tools and keeps UTF-8 names and file bytes', (t) => {
  const { root, dist } = fixture(t);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'café.txt'), 'Synthetic lecture content.\n'.repeat(40));
  writeFileSync(join(dist, 'assets', 'empty.txt'), '');
  writeFileSync(join(dist, 'assets', 'binary.bin'), Buffer.from([0, 255, 6, 128]));
  const zip = join(root, 'extension.zip');
  writeFileSync(zip, createExtensionArchive(dist));
  const result = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    print(json.dumps({name: list(archive.read(name)) for name in archive.namelist()}))
`,
        zip,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(Object.keys(result), [
    'assets/binary.bin',
    'assets/café.txt',
    'assets/empty.txt',
    'manifest.json',
  ]);
  assert.deepEqual(result['assets/binary.bin'], [0, 255, 6, 128]);
  assert.equal(
    Buffer.from(result['assets/café.txt']).toString(),
    'Synthetic lecture content.\n'.repeat(40),
  );
  assert.deepEqual(result['assets/empty.txt'], []);
});

test('same build produces identical ZIP bytes after timestamps change', (t) => {
  const { dist } = fixture(t);
  const first = createExtensionArchive(dist);
  utimesSync(join(dist, 'manifest.json'), new Date(2030, 1, 1), new Date(2030, 1, 1));
  assert.deepEqual(createExtensionArchive(dist), first);
});

test('missing manifest and symbolic links fail before packaging outside files', (t) => {
  const { root, dist } = fixture(t);
  const linkedDist = join(root, 'linked-dist');
  symlinkSync(dist, linkedDist);
  assert.throws(() => createExtensionArchive(linkedDist), /symbolic link/);
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.throws(() => createExtensionArchive(empty), /manifest.json is missing/);
  writeFileSync(join(root, 'private.txt'), 'Synthetic private input.');
  symlinkSync(join(root, 'private.txt'), join(dist, 'linked.txt'));
  assert.throws(() => createExtensionArchive(dist), /symbolic link/);
});

test('unsafe archive filenames are refused', (t) => {
  const { dist } = fixture(t);
  writeFileSync(join(dist, 'unsafe\nname.txt'), 'Synthetic content.');
  assert.throws(() => createExtensionArchive(dist), /Unsafe ZIP path/);
});

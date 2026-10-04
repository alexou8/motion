import assert from 'node:assert/strict';
import test from 'node:test';
import { containsDomGlobals } from './worker-source.mjs';

test('worker validation rejects actual DOM globals, including computed access', () => {
  for (const source of [
    'window.location.href',
    'document.querySelector("main")',
    'document["title"]',
    'globalThis.document',
    'self["window"]',
    'window()',
  ])
    assert.equal(containsDomGlobals(source), true, source);
});
test('worker validation ignores document prose, property names and comments', () => {
  for (const source of [
    'throw new Error("Motion could not save this document. Try again.")',
    'const x = { document: "synthetic" }; x.document',
    '// document.querySelector("main")\nchrome.runtime.id',
    'const pattern = /document[.]title/',
  ])
    assert.equal(containsDomGlobals(source), false, source);
});

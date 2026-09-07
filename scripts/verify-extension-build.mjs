import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const workerPath = join(dist, manifest.background.service_worker);
const visited = new Set();
const workerModules = [];

function collectImports(modulePath) {
  const source = readFileSync(modulePath, 'utf8');
  if (visited.has(modulePath)) return;
  visited.add(modulePath);
  workerModules.push({ path: modulePath, source });

  const imports = [...source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](.+?)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'));
  for (const specifier of imports) collectImports(join(dirname(modulePath), specifier));
}

collectImports(workerPath);

if (workerModules.length === 1) {
  throw new Error(`Could not resolve the service worker entry from ${workerPath}.`);
}

if (workerModules.some((module) => /content-script/i.test(module.path))) {
  throw new Error('The service worker module graph resolves to the content-script bundle.');
}

const workerEntry = workerModules.find((module) => /service-worker(?!-loader)/i.test(module.path));
if (!workerEntry) {
  throw new Error('The service worker loader does not resolve to a distinct service-worker entry.');
}

if (/\b(?:window|document)\s*[.[]/.test(workerEntry.source)) {
  throw new Error('The service worker bundle contains DOM globals and will fail to register.');
}

console.log('Verified that the service worker bundle is free of DOM globals.');

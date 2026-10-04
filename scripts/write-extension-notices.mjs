import { readFileSync, writeFileSync } from 'node:fs';

const licenses = [
  ['IBM Plex Sans and Mono', 'src/assets/fonts/OFL-ibm-plex.txt'],
  ['Source Serif 4', 'src/assets/fonts/OFL-source-serif-4.txt'],
  ['React', 'node_modules/react/LICENSE'],
  ['React DOM', 'node_modules/react-dom/LICENSE'],
  ['Zod', 'node_modules/zod/LICENSE'],
  ['clsx', 'node_modules/clsx/license'],
  ['tailwind-merge', 'node_modules/tailwind-merge/LICENSE.md'],
];

writeFileSync(
  'dist/THIRD_PARTY_NOTICES.txt',
  licenses.map(([name, path]) => `${name}\n${readFileSync(path, 'utf8')}`).join('\n\n'),
);
console.log('Included bundled font and runtime library licenses.');

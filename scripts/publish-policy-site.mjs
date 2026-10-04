import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.argv[2] !== '--publish') throw new Error('Publishing requires the explicit --publish flag. Build and review the site first.');
const repository = 'repos/alexou8/motion';
const files = ['index.html', 'privacy.html', '404.html', 'privacy.md', 'site.css', '.nojekyll',
  'assets/motion-mark.svg', 'assets/icon-32.png', 'assets/ibm-plex-sans.woff2', 'assets/source-serif.woff2',
  'licenses/ibm-plex.txt', 'licenses/source-serif-4.txt'];
const policy = await readFile('docs/PRIVACY.md', 'utf8');
if (await readFile('.motion-site/privacy.md', 'utf8') !== policy) throw new Error('Rebuild the site: policy source changed.');
const contents = await Promise.all(files.map((file) => readFile(join('.motion-site', file))));
const temp = await mkdtemp(join(tmpdir(), 'motion-policy-publish-'));
async function api(path, method = 'GET', body) {
  const args = ['api', `${repository}/${path}`, '--method', method];
  if (body) {
    const input = join(temp, 'request.json');
    await writeFile(input, JSON.stringify(body));
    args.push('--input', input);
  }
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
async function optional(path) {
  try { return await api(path); }
  catch (error) {
    if (String(error.stderr).includes('HTTP 404')) return null;
    throw error;
  }
}
try {
  const pages = await optional('pages');
  if (pages && (pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/'))
    throw new Error('Existing Pages configuration differs; preserve it and choose a deployment target explicitly.');
  const previous = await optional('git/ref/heads/gh-pages');
  const parent = previous ? await api(`git/commits/${previous.object.sha}`) : null;
  const treeEntries = [];
  for (let i = 0; i < files.length; i++) {
    const blob = await api('git/blobs', 'POST', { content: contents[i].toString('base64'), encoding: 'base64' });
    treeEntries.push({ path: files[i], mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await api('git/trees', 'POST', { tree: treeEntries, ...(parent ? { base_tree: parent.tree.sha } : {}) });
  const commit = await api('git/commits', 'POST', { message: 'Publish Motion privacy policy', tree: tree.sha, parents: previous ? [previous.object.sha] : [] });
  if (previous) await api('git/refs/heads/gh-pages', 'PATCH', { sha: commit.sha, force: false });
  else await api('git/refs', 'POST', { ref: 'refs/heads/gh-pages', sha: commit.sha });
  if (!pages) await api('pages', 'POST', { source: { branch: 'gh-pages', path: '/' }, build_type: 'legacy' });
  else await api('pages/builds', 'POST', {});
  console.log(`Published policy files to gh-pages (${commit.sha}). Verify https://alexou8.github.io/motion/privacy.html after Pages finishes building.`);
} finally { await rm(temp, { recursive: true, force: true }); }

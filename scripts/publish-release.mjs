/** Publish validated artifacts; repository-write credentials are needed only here. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateVersion, writeChecksums } from './release.mjs';

function github(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function releaseNotes(metadata, channel) {
  return (
    `Motion ${metadata.version}${channel === 'main' ? ' — development build' : ''}\n\n` +
    `Source commit: \`${metadata.sha}\`. Requires Chrome ${metadata.minimumChrome} or newer.\n\n` +
    (channel === 'main'
      ? 'This prerelease follows validated main commits and may contain unfinished features.\n\n'
      : '') +
    `1. Download \`${metadata.extension}\` and unzip it.\n` +
    '2. Open `chrome://extensions` and turn on **Developer mode**.\n' +
    '3. Choose **Load unpacked** and select the unzipped folder.\n\n' +
    'Verify downloads with `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`). ' +
    'Download both ZIPs and `motion-release.json` beside `SHA256SUMS` to verify the entire release.\n\n' +
    `\`${metadata.companion}\` is the optional OS keychain companion; its README explains installation. ` +
    'API keys stay in the browser session unless you explicitly enable that companion.\n\n' +
    'This is an unpacked developer build, not a Chrome Web Store listing.\n'
  );
}

export function publishRelease({
  channel,
  tag,
  sha,
  repository,
  directory = '.motion-release',
  run = github,
}) {
  if (
    !['main', 'version'].includes(channel) ||
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')
  )
    throw new Error('Invalid release publishing context.');
  const metadata = JSON.parse(readFileSync(join(directory, 'motion-release.json'), 'utf8'));
  validateVersion(metadata.version);
  if (
    metadata.sha !== sha ||
    typeof metadata.minimumChrome !== 'string' ||
    !/^\d+(?:\.\d+){0,3}$/.test(metadata.minimumChrome) ||
    metadata.extension !== `motion-extension-${metadata.version}.zip` ||
    metadata.companion !== `motion-keychain-companion-${metadata.version}.zip`
  ) {
    throw new Error('Release artifact metadata does not match this source commit.');
  }
  const assets = [metadata.extension, metadata.companion, 'motion-release.json'];
  const expectedChecksums = assets
    .map(
      (name) =>
        `${createHash('sha256')
          .update(readFileSync(join(directory, name)))
          .digest('hex')}  ${name}\n`,
    )
    .join('');
  if (readFileSync(join(directory, 'SHA256SUMS'), 'utf8') !== expectedChecksums) {
    throw new Error('Release artifact checksum verification failed.');
  }
  if (channel === 'version' && tag !== `v${metadata.version}`)
    throw new Error('Tag does not match release metadata.');
  if (channel === 'main') tag = 'main-build';

  const api = (path, args = []) => JSON.parse(run(['api', `repos/${repository}/${path}`, ...args]));
  const optionalApi = (path) => {
    try {
      return api(path);
    } catch (error) {
      if (/\(HTTP 404\)/.test(String(error.stderr ?? ''))) return null;
      throw error;
    }
  };
  if (channel === 'main') {
    const current = api('git/ref/heads/main');
    if (current.object?.type !== 'commit' || current.object.sha !== sha) {
      console.log('Skipping superseded main build; a newer commit is waiting for validation.');
      return { skipped: true };
    }
  } else {
    let object = api(`git/ref/tags/${tag}`).object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
      object = api(`git/tags/${object.sha}`).object;
    }
    if (object?.type !== 'commit' || object.sha !== sha)
      throw new Error('Remote release tag does not point to the validated commit.');
  }

  const existing = optionalApi(`releases/tags/${tag}`);
  if (existing && (existing.immutable || (channel === 'version' && !existing.draft))) {
    throw new Error(
      `Release ${tag} is already published or immutable; its assets will not be replaced.`,
    );
  }
  const notes = join(directory, 'release-notes.md');
  if (channel === 'main') {
    metadata.extension = 'motion-extension-latest.zip';
    metadata.companion = 'motion-keychain-companion-latest.zip';
    copyFileSync(join(directory, assets[0]), join(directory, metadata.extension));
    copyFileSync(join(directory, assets[1]), join(directory, metadata.companion));
    writeFileSync(join(directory, 'motion-release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    assets[0] = metadata.extension;
    assets[1] = metadata.companion;
    writeChecksums(directory, assets);
    if (existing)
      run([
        'release',
        'edit',
        tag,
        '--repo',
        repository,
        '--draft=true',
        '--latest=false',
        '--prerelease',
      ]);
    const ref = optionalApi(`git/ref/tags/${tag}`);
    if (ref)
      api(`git/refs/tags/${tag}`, ['--method', 'PATCH', '-f', `sha=${sha}`, '-F', 'force=true']);
    else api('git/refs', ['--method', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
  }
  writeFileSync(notes, releaseNotes(metadata, channel));
  if (!existing) {
    run([
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--target',
      sha,
      '--draft',
      '--latest=false',
      '--title',
      channel === 'main' ? 'Motion — latest main build' : `Motion ${metadata.version}`,
      '--notes-file',
      notes,
      ...(channel === 'main' ? ['--prerelease'] : ['--generate-notes']),
    ]);
  } else if (channel === 'main') {
    run([
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--notes-file',
      notes,
      '--title',
      'Motion — latest main build',
    ]);
  }
  run([
    'release',
    'upload',
    tag,
    '--repo',
    repository,
    '--clobber',
    ...[...assets, 'SHA256SUMS'].map((name) => join(directory, name)),
  ]);

  let latest = false;
  if (channel === 'version') {
    const previous = optionalApi('releases/latest');
    const previousVersion = /^v(\d+\.\d+\.\d+)$/.exec(previous?.tag_name ?? '')?.[1];
    const compare = (left, right) => {
      for (let i = 0; i < 3; i++) {
        const difference = Number(left.split('.')[i]) - Number(right.split('.')[i]);
        if (difference) return difference;
      }
      return 0;
    };
    latest = !previousVersion || compare(metadata.version, previousVersion) >= 0;
  }
  run(['release', 'edit', tag, '--repo', repository, '--draft=false', `--latest=${latest}`]);
  return { skipped: false, tag, latest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    publishRelease({
      channel: process.argv[2],
      tag: process.env.GITHUB_REF_NAME,
      sha: process.env.GITHUB_SHA,
      repository: process.env.GITHUB_REPOSITORY,
    });
  } catch (error) {
    console.error(error.message);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}

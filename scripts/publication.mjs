import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { combinations, identity, installer, readJson, run } from './lib.mjs';

function regularFiles(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error('Source must be a regular directory.');
  const files = [];
  for (const name of readdirSync(directory)) {
    if (name.toLowerCase() === '.git') throw new Error('Artifact contains a .git path component.');
    const file = resolve(directory, name);
    const entry = lstatSync(file);
    if (entry.isDirectory()) files.push(...regularFiles(file));
    else if (entry.isFile() && entry.nlink === 1) files.push(file);
    else throw new Error(`Artifact contains a link or special file: ${file}`);
  }
  return files;
}

export async function extractSource(archive, source) {
  if (existsSync(source)) throw new Error(`Source directory already exists: ${source}`);
  await run('python3', ['-I', '-c', `
import ntpath, posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    for member in members:
        parts = member.name.replace('\\\\', '/').split('/')
        if posixpath.isabs(member.name) or ntpath.isabs(member.name) or '..' in parts:
            raise ValueError('Artifact contains an absolute path or .. component: ' + member.name)
        if any(part.lower() == '.git' for part in parts):
            raise ValueError('Artifact contains a .git path component: ' + member.name)
        if not (member.isfile() or member.isdir()):
            raise ValueError('Artifact contains a link or special file: ' + member.name)
    archive.extractall(sys.argv[2], members=members, filter='data')
`, archive, source], { capture: true });
  regularFiles(source);
}

export function requirePassingResults(id, directory) {
  for (const { backend } of combinations()) {
    const file = resolve(directory, `${id}--${backend}.json`);
    if (!existsSync(file)) throw new Error(`Missing result: ${backend}`);
    const result = readJson(file);
    if (result.variant !== id || result.backend !== backend || result.passed !== true) throw new Error(`Backend did not pass: ${backend}`);
  }
}

export async function publishTree({ source, checkout, remote, env = {} }) {
  const files = regularFiles(source);
  if (!existsSync(resolve(source, 'composer.lock'))) throw new Error('Generated source artifact is missing.');
  if (existsSync(checkout)) throw new Error(`Publication checkout already exists: ${checkout}`);
  mkdirSync(checkout, { recursive: true });
  const git = (args, options = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: checkout, capture: true, env: { ...identity, GIT_TERMINAL_PROMPT: '0', ...env }, ...options,
  });
  await git(['init', '--initial-branch=main']);
  await git(['remote', 'add', 'origin', remote]);
  if (remote.startsWith('https://github.com/')) {
    await git(['config', 'credential.helper', '']);
    await git(['config', '--add', 'credential.helper', '!gh auth git-credential']);
  }
  const refs = await git(['ls-remote', '--heads', 'origin']);
  const main = refs.stdout.split('\n').find((line) => line.endsWith('\trefs/heads/main'));
  if (main) {
    await git(['fetch', 'origin', 'main']);
    await git(['checkout', '-B', 'main', 'FETCH_HEAD']);
    await git(['rm', '-r', '--ignore-unmatch', '.']);
  } else if (refs.stdout.trim()) {
    throw new Error('Destination has branches but no main. Refusing to replace another history.');
  }
  for (const file of files) {
    const destination = resolve(checkout, file.slice(resolve(source).length + 1));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
  }
  // Normal git add honors the generated application's .gitignore.
  await git(['add', '--all']);
  const diff = await git(['diff', '--cached', '--quiet'], { allowFailure: true });
  let status = 'unchanged';
  if (diff.code !== 0) {
    if (diff.code !== 1) throw new Error('Cannot inspect the staged tree.');
    await git(['commit', '-m', `chore: regenerate with laravel/installer v${installer}`]);
    const destination = (await git(['remote', 'get-url', '--push', 'origin'])).stdout.trim();
    const branch = (await git(['branch', '--show-current'])).stdout.trim();
    if (destination !== remote || branch !== 'main') throw new Error('Unexpected publication destination.');
    // No force pushes: concurrent updates reject the push and retain remote history.
    await git(['push', '--set-upstream', 'origin', 'HEAD:refs/heads/main']);
    status = 'pushed';
  }
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const actual = (await git(['ls-remote', 'origin', 'refs/heads/main'])).stdout.split(/\s/)[0];
  if (actual !== head) throw new Error('Remote main does not match the verified commit.');
  return { status, head };
}

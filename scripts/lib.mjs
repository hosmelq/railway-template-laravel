import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const work = resolve(root, '.work');
export const owner = 'hosmelq';
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const variants = readJson(resolve(root, 'data/variants.json'));
export const backends = readJson(resolve(root, 'data/backends.json'));
export const installer = readJson(resolve(root, 'composer.json')).require['laravel/installer'];
export const identity = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};

export function variant(id) {
  const result = variants.find((entry) => entry.id === id);
  if (!result) throw new Error(`Unknown variant: ${id}`);
  return result;
}

export function combinations() {
  return backends.databases.flatMap((database) => [false, true].map((redis) => ({
    backend: `${database.id}${redis ? '-redis' : ''}`, database: database.id, redis,
  })));
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function run(command, args = [], options = {}) {
  const { cwd = root, env = {}, capture = false, allowFailure = false, input, ...rest } = options;
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      ...rest,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${command} failed (${code ?? signal})\n${stdout}\n${stderr}`));
      } else resolveRun({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function sourceFiles(directory) {
  const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: directory, capture: true });
  return [...new Set(stdout.split('\0').filter(Boolean))].filter((file) => existsSync(resolve(directory, file))).sort();
}

export function mailNote({ auth, flags }) {
  const logs = auth
    ? 'On Railway, email verification and password reset links appear in the **APP logs**.'
    : 'The application sends no mail out of the box. On Railway, mail sent during a request appears in the **APP logs** and queued mail in the **Queue logs**.';
  const teams = flags.includes('--teams') ? ' Team invitations are queued, so their mail appears in the **Queue logs**.' : '';
  return `Mail uses \`log\` by default. ${logs}${teams} Locally, look in \`storage/logs/laravel.log\`.`;
}

export const imageTag = (id, service) => `laravel-template-${id}-${service}:test`;
export const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

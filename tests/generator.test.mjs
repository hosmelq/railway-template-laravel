import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { combinations, identity, installer, mailNote, run, variant, work, writeJson } from '../scripts/lib.mjs';
import { extractSource, publishTree, requirePassingResults } from '../scripts/publication.mjs';

mkdirSync(work, { recursive: true });
const temporary = () => mkdtempSync(resolve(work, 'safety-'));
const git = (cwd, args) => run('git', args, { cwd, capture: true, env: identity });

test('the README mail note matches what each variant sends', () => {
  assert.match(mailNote(variant('blade')), /sends no mail out of the box/);
  assert.doesNotMatch(mailNote(variant('blade')), /verification|invitations/);
  assert.match(mailNote(variant('react')), /verification and password reset links appear in the \*\*APP logs\*\*/);
  assert.doesNotMatch(mailNote(variant('react')), /invitations/);
  assert.match(mailNote(variant('livewire-teams')), /Team invitations are queued/);
});

test('publication rejects missing, failed, or mismatched backend evidence', () => {
  const directory = temporary();
  assert.throws(() => requirePassingResults('blade', directory), /Missing result/);
  for (const { backend } of combinations()) writeJson(resolve(directory, `blade--${backend}.json`), { variant: 'blade', backend, passed: true });
  assert.doesNotThrow(() => requirePassingResults('blade', directory));
  writeJson(resolve(directory, 'blade--postgres.json'), { variant: 'blade', backend: 'postgres', passed: false });
  assert.throws(() => requirePassingResults('blade', directory), /Backend did not pass: postgres/);
  writeJson(resolve(directory, 'blade--postgres.json'), { variant: 'vue', backend: 'postgres', passed: true });
  assert.throws(() => requirePassingResults('blade', directory), /Backend did not pass: postgres/);
});

test('publication rejects an artifact containing .git/hooks/pre-commit before extraction', async () => {
  const directory = temporary();
  const source = resolve(directory, 'source');
  mkdirSync(resolve(source, '.git/hooks'), { recursive: true });
  writeFileSync(resolve(source, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n');
  writeFileSync(resolve(source, 'composer.lock'), '{}\n');
  const archive = resolve(directory, 'source.tar.gz');
  await run('tar', ['-czf', archive, '-C', source, '.'], { capture: true });
  const extracted = resolve(directory, 'extracted');
  await assert.rejects(extractSource(archive, extracted), /\.git path component/);
  assert.equal(existsSync(extracted), false);
  await assert.rejects(publishTree({ source, checkout: resolve(directory, 'checkout'), remote: resolve(directory, 'unused.git') }), /\.git path component/);
  assert.equal(existsSync(resolve(directory, 'checkout')), false);
});

test('publication rejects a symlink in an artifact and in an extracted tree', async () => {
  const directory = temporary();
  const source = resolve(directory, 'source');
  mkdirSync(source);
  writeFileSync(resolve(source, 'composer.lock'), '{}\n');
  symlinkSync('composer.lock', resolve(source, 'linked.lock'));
  const archive = resolve(directory, 'source.tar.gz');
  await run('tar', ['-czf', archive, '-C', source, '.'], { capture: true });
  await assert.rejects(extractSource(archive, resolve(directory, 'extracted')), /link or special file/);
  assert.equal(existsSync(resolve(directory, 'extracted')), false);
  await assert.rejects(publishTree({ source, checkout: resolve(directory, 'checkout'), remote: resolve(directory, 'unused.git') }), /link or special file/);
});

test('regeneration replaces the tree, preserves history and ignores local state; an identical tree creates no commit', async () => {
  const directory = temporary();
  const remote = resolve(directory, 'remote.git');
  const seed = resolve(directory, 'seed');
  const source = resolve(directory, 'source');
  await git(directory, ['init', '--bare', '--initial-branch=main', remote]);
  await git(directory, ['clone', remote, seed]);
  writeFileSync(resolve(seed, 'old-app.php'), '<?php // Existing application\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'chore: initialize existing application']);
  await git(seed, ['push', 'origin', 'main']);
  const original = (await git(seed, ['rev-parse', 'HEAD'])).stdout.trim();
  mkdirSync(source);
  writeFileSync(resolve(source, 'composer.lock'), '{}\n');
  writeFileSync(resolve(source, '.gitignore'), '.env\ndatabase.sqlite\n');
  writeFileSync(resolve(source, '.env'), 'PRIVATE=local-only\n');
  writeFileSync(resolve(source, 'database.sqlite'), 'local-only\n');
  const first = await publishTree({ source, checkout: resolve(directory, 'first'), remote });
  assert.equal(first.status, 'pushed');
  assert.equal((await git(remote, ['rev-parse', 'main^'])).stdout.trim(), original);
  assert.deepEqual((await git(remote, ['ls-tree', '--name-only', 'main'])).stdout.trim().split('\n'), ['.gitignore', 'composer.lock']);
  assert.equal((await git(remote, ['log', '-1', '--format=%s', 'main'])).stdout.trim(), `chore: regenerate with laravel/installer v${installer}`);
  assert.equal((await git(remote, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'])).stdout.trim(),
    'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
  const second = await publishTree({ source, checkout: resolve(directory, 'second'), remote });
  assert.equal(second.status, 'unchanged');
  assert.equal(second.head, first.head);
});

test('an empty destination gets main without creating a repository on a hosting service', async () => {
  const directory = temporary();
  const remote = resolve(directory, 'remote.git');
  const source = resolve(directory, 'source');
  await git(directory, ['init', '--bare', '--initial-branch=main', remote]);
  mkdirSync(source);
  writeFileSync(resolve(source, 'composer.lock'), '{}\n');
  const archive = resolve(directory, 'source.tar.gz');
  await run('tar', ['-czf', archive, '-C', source, '.'], { capture: true });
  const extracted = resolve(directory, 'extracted');
  await extractSource(archive, extracted);
  const result = await publishTree({ source: extracted, checkout: resolve(directory, 'checkout'), remote });
  assert.equal(result.status, 'pushed');
  assert.equal((await git(remote, ['rev-list', '--count', 'main'])).stdout.trim(), '1');
});

test('a destination with another branch and no main is left untouched', async () => {
  const directory = temporary();
  const remote = resolve(directory, 'remote.git');
  const seed = resolve(directory, 'seed');
  const source = resolve(directory, 'source');
  await git(directory, ['init', '--bare', '--initial-branch=production', remote]);
  await git(directory, ['clone', remote, seed]);
  writeFileSync(resolve(seed, 'old-app.php'), '<?php\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'chore: initialize existing application']);
  await git(seed, ['push', 'origin', 'production']);
  const original = (await git(remote, ['show-ref'])).stdout;
  mkdirSync(source);
  writeFileSync(resolve(source, 'composer.lock'), '{}\n');
  await assert.rejects(publishTree({ source, checkout: resolve(directory, 'checkout'), remote }), /no main/);
  assert.equal((await git(remote, ['show-ref'])).stdout, original);
});

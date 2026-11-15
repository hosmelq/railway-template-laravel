import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { combinations, identity, installer, readJson, root, run, variant, variants, work, writeJson } from './lib.mjs';

let selected = [];
let planningError;
try {
  selected = process.argv[2] ? [variant(process.argv[2])] : variants;
} catch (error) {
  planningError = error.message;
}
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== 'hosmelq/railway-template-laravel') throw new Error('Run finalization only in the generator repository.');
const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const report = [];
const versions = readJson(resolve(root, 'versions.json'));
versions.installer = installer;
versions.lastRun = { at: new Date().toISOString(), url: runUrl };
mkdirSync(resolve(work, 'issues'), { recursive: true });
let failed = false;
async function updateIssue(title, problems, filename) {
  try {
    const issues = JSON.parse((await run('gh', ['issue', 'list', '--repo', repository, '--state', 'open', '--search', `${title} in:title`, '--json', 'number,title'], { capture: true })).stdout);
    const existing = issues.find((issue) => issue.title === title);
    if (problems.length) {
      failed = true;
      const bodyFile = resolve(work, 'issues', `${filename}.md`);
      writeFileSync(bodyFile, `Regeneration failed. No unverified tree is published.\n\n${problems.map((problem) => `- ${problem}`).join('\n')}\n\n[Workflow run](${runUrl})\n`);
      await run('gh', existing
        ? ['issue', 'edit', String(existing.number), '--repo', repository, '--body-file', bodyFile]
        : ['issue', 'create', '--repo', repository, '--title', title, '--body-file', bodyFile]);
    } else if (existing) {
      await run('gh', ['issue', 'close', String(existing.number), '--repo', repository]);
    }
  } catch (error) {
    failed = true;
    console.error(`Could not maintain failure issue: ${error.message}`);
  }
}

const planningFailed = planningError || process.env.PLAN_RESULT !== 'success';
await updateIssue('[regenerate] workflow planning failed',
  planningFailed ? ['Workflow planning did not complete; inspect the plan job.'] : [], 'planning');
for (const selectedVariant of planningFailed ? [] : selected) {
  const { id } = selectedVariant;
  const versionFile = resolve(work, 'versions', `${id}.json`);
  const problems = [];
  if (!existsSync(versionFile)) problems.push('Generation did not produce a package inventory.');
  for (const { backend } of combinations()) {
    const file = resolve(work, 'results', `${id}--${backend}.json`);
    if (!existsSync(file)) problems.push(`${backend}: no test result (generation, build or infrastructure failure).`);
    else if (readJson(file).passed !== true) problems.push(`${backend}: failed; see the run logs and artifacts.`);
  }
  const publicationFile = resolve(work, 'published', `${id}.json`);
  const publication = existsSync(publicationFile) ? readJson(publicationFile) : null;
  if (!publication || !['pushed', 'unchanged'].includes(publication.status)) problems.push('Publication did not complete; see the publication job.');
  else if (existsSync(versionFile)) versions.variants[id] = readJson(versionFile);
  report.push(`| ${id} | ${problems.length ? 'Failed' : publication.status} |`);
  await updateIssue(`[regenerate] ${id} failed`, problems, id);
}

// A fresh run timestamp records activity even when dependency versions are unchanged.
// Commit only this file, preserving concurrent commits on main via a rebase.
writeJson(resolve(root, 'versions.json'), versions);
const git = (args, options = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env: identity, ...options });
await git(['add', '--', 'versions.json']);
await git(['commit', '-m', 'chore: record Laravel template regeneration']);
await git(['fetch', 'origin', 'main']);
await git(['rebase', 'origin/main']);
const remote = (await git(['remote', 'get-url', '--push', 'origin'], { capture: true })).stdout.trim();
if (remote !== `https://github.com/${repository}` && remote !== `https://github.com/${repository}.git`) throw new Error('Unexpected generator remote.');
await git(['push', 'origin', 'HEAD:refs/heads/main']);
const head = (await git(['rev-parse', 'HEAD'], { capture: true })).stdout.trim();
const actual = (await git(['ls-remote', 'origin', 'refs/heads/main'], { capture: true })).stdout.split(/\s/)[0];
if (head !== actual) throw new Error('Version inventory was not confirmed on remote main.');
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `| Variant | Result |\n| --- | --- |\n${report.join('\n')}\n`);
process.exitCode = failed ? 1 : 0;

import { resolve } from 'node:path';
import { owner, variant, work, writeJson } from './lib.mjs';
import { extractSource, publishTree, requirePassingResults } from './publication.mjs';

const selected = variant(process.argv[2]);
const result = { variant: selected.id, status: 'failed' };
try {
  requirePassingResults(selected.id, resolve(work, 'results'));
  if (!process.env.VARIANTS_TOKEN) throw new Error('VARIANTS_TOKEN is required to publish.');
  await extractSource(resolve(work, 'bundles', `${selected.id}.tar.gz`), resolve(work, 'source', selected.id));
  Object.assign(result, await publishTree({
    source: resolve(work, 'source', selected.id), checkout: resolve(work, 'publish', selected.id),
    remote: `https://github.com/${owner}/${selected.repo}.git`, env: { GH_TOKEN: process.env.VARIANTS_TOKEN },
  }));
} catch (error) {
  result.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeJson(resolve(work, 'published', `${selected.id}.json`), result);
}

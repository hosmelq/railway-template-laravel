import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { imageTag, run, variant, work } from './lib.mjs';

const { id } = variant(process.argv[2]);
const services = ['app', 'queue', 'scheduler'];
for (const service of services) {
  await run('docker', ['build', '--progress=plain', '--file', `docker/${service}/Dockerfile`,
    '--build-arg', 'APP_NAME=Laravel', '--tag', imageTag(id, service), '.',
  ], { cwd: resolve(work, 'source', id) });
}

if (process.argv.includes('--archive')) {
  mkdirSync(resolve(work, 'images'), { recursive: true });
  await run('docker', ['save', '--output', resolve(work, 'images', `${id}.tar`), ...services.map((service) => imageTag(id, service))]);
}

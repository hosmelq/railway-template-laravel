import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { backends, combinations, imageTag, pause, root, run, variant, work, writeJson } from './lib.mjs';

const selected = variant(process.argv[2]);
const requested = process.argv[3];
const cases = combinations().filter(({ backend }) => !requested || requested === backend);
if (!cases.length) throw new Error(`Unknown backend: ${requested}`);
const images = {};
for (const service of ['app', 'queue', 'scheduler']) {
  images[service] = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag(selected.id, service)], { capture: true })).stdout.trim();
}
let failures = 0;
for (const entry of cases) {
  const prefix = `laravel-test-${selected.id}-${entry.backend}-${randomBytes(3).toString('hex')}`;
  const directory = resolve(work, 'runs', prefix);
  mkdirSync(directory, { recursive: true });
  const database = backends.databases.find(({ id }) => id === entry.database);
  const containers = [];
  const result = { variant: selected.id, backend: entry.backend, images, passed: false, checks: {}, startedAt: new Date().toISOString() };
  let networkCreated = false;
  const docker = (args, options = {}) => run('docker', args, options);
  const log = (name, value) => writeFileSync(resolve(directory, `${name}.log`), value);
  async function check(name, fn) {
    console.log(`[${selected.id}/${entry.backend}] ${name}`);
    await fn();
    result.checks[name] = true;
  }
  async function waitFor(fn, timeout = 90000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try { await fn(); return; } catch (error) { lastError = error; }
      await pause(1500);
    }
    throw lastError ?? new Error('Readiness timed out.');
  }
  async function start(name, image, options = [], command = []) {
    const container = `${prefix}-${name}`;
    containers.push(container);
    await docker(['run', '--detach', '--name', container, '--network', prefix, ...options, image, ...command], { capture: true });
    return container;
  }
  const envOptions = (values) => Object.entries(values).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const mount = (source, target) => ['--mount', `type=bind,source=${source},target=${target},readonly`];
  const fixture = (file) => resolve(root, 'tests/fixtures', file);
  const mounts = [
    ...mount(fixture('smoke.php'), '/tmp/template-smoke.php'),
    ...mount(fixture('TemplateSmokeJob.php'), '/var/www/html/app/Jobs/TemplateSmokeJob.php'),
  ];
  const env = {
    APP_ENV: 'production', APP_DEBUG: 'false', APP_KEY: `base64:${randomBytes(32).toString('base64')}`, APP_URL: 'https://template.example',
    DB_CONNECTION: database.connection,
    DB_URL: `${database.connection === 'pgsql' ? 'postgres' : database.connection}://laravel:template-password@database:${database.port}/laravel`,
    FILESYSTEM_DISK: 's3', AWS_ACCESS_KEY_ID: 'template-access', AWS_SECRET_ACCESS_KEY: 'template-secret-password',
    AWS_DEFAULT_REGION: 'us-east-1', AWS_BUCKET: 'files', AWS_ENDPOINT: 'http://s3:9000',
    LOG_CHANNEL: 'stderr', LOG_STDERR_FORMATTER: '\\Monolog\\Formatter\\JsonFormatter',
    ...(entry.redis ? { CACHE_STORE: 'redis', QUEUE_CONNECTION: 'redis', SESSION_DRIVER: 'redis', REDIS_URL: 'redis://default:template-password@redis:6379' } : {}),
  };

  try {
    await docker(['network', 'create', prefix], { capture: true });
    networkCreated = true;
    await check('database-ready', async () => {
      const variables = database.id === 'postgres'
        ? { POSTGRES_USER: 'laravel', POSTGRES_PASSWORD: 'template-password', POSTGRES_DB: 'laravel' }
        : { MYSQL_ROOT_PASSWORD: 'template-root-password', MYSQL_DATABASE: 'laravel', MYSQL_USER: 'laravel', MYSQL_PASSWORD: 'template-password' };
      const db = await start('database', database.image, ['--network-alias', 'database', ...envOptions(variables)]);
      const ready = database.id === 'postgres'
        ? ['pg_isready', '-h', '127.0.0.1', '-U', 'laravel', '-d', 'laravel']
        : [database.id === 'mariadb' ? 'mariadb-admin' : 'mysqladmin', 'ping', '--host=127.0.0.1', '--user=root', '--password=template-root-password', '--silent'];
      await waitFor(() => docker(['exec', db, ...ready], { capture: true }));
      if (database.id === 'postgres') {
        await docker(['exec', db, 'createdb', '-U', 'laravel', 'laravel_test'], { capture: true });
      } else {
        await docker(['exec', db, database.id === 'mariadb' ? 'mariadb' : 'mysql', '--user=root', '--password=template-root-password',
          '-e', "CREATE DATABASE laravel_test; GRANT ALL ON laravel_test.* TO 'laravel'@'%';"], { capture: true });
      }
    });

    if (entry.redis) {
      const redis = await start('redis', backends.redis, ['--network-alias', 'redis'], ['redis-server', '--requirepass', 'template-password']);
      await waitFor(() => docker(['exec', redis, 'redis-cli', '-a', 'template-password', 'ping'], { capture: true }));
    }
    await start('s3', backends.s3, ['--network-alias', 's3', '--network-alias', 'files.s3', '--tmpfs', '/data', ...envOptions({
      ROOT_ACCESS_KEY: env.AWS_ACCESS_KEY_ID, ROOT_SECRET_KEY: env.AWS_SECRET_ACCESS_KEY,
    })], ['--port', ':9000', '--virtual-domain', 's3', 'posix', '/data']);

    // These workers start before APP on an empty database. Their entrypoints must
    // never migrate it. Wait for their optimization stage, then assert it is empty.
    const before = [];
    for (const service of ['queue', 'scheduler']) {
      const name = await start(`pre-${service}`, images[service], envOptions(env), ['php', '-r', 'echo "template-entrypoint-ready\\n"; sleep(90);']);
      before.push(name);
      await waitFor(async () => {
        const logs = await docker(['logs', name], { capture: true });
        if (!`${logs.stdout}${logs.stderr}`.includes('template-entrypoint-ready')) throw new Error('Worker entrypoint is not ready.');
      });
    }
    await check('workers-do-not-migrate', async () => {
      await docker(['exec', before[0], 'php', '-r',
        'require "vendor/autoload.php"; $app=require "bootstrap/app.php"; $app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap(); if (Illuminate\\Support\\Facades\\Schema::hasTable("migrations")) {exit(1);}'], { capture: true });
      await docker(['stop', '--time=2', ...before], { capture: true });
    });

    const app = await start('app', images.app, [...envOptions(env), ...mounts, '--publish', '127.0.0.1::8080']);
    const smoke = (command) => docker(['exec', app, 'php', '/tmp/template-smoke.php', command], { capture: true });
    const { stdout: mapping } = await docker(['port', app, '8080/tcp'], { capture: true });
    const baseUrl = `http://${mapping.trim()}`;
    const headers = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.10' };
    await check('health', () => waitFor(async () => {
      const response = await fetch(`${baseUrl}/up`, { headers, signal: AbortSignal.timeout(5000) });
      if (response.status !== 200) throw new Error(`/up returned ${response.status}`);
    }, 120000));
    await check('migrations-and-drivers', async () => {
      const response = await smoke('database');
      log('database', response.stdout + response.stderr);
      if (!response.stderr.split('\n').some((line) => {
        try { return JSON.parse(line).message === 'template-smoke-json-log'; } catch { return false; }
      })) throw new Error('stderr did not contain the expected JSON log.');
    });
    await check('pages', async () => {
      for (const route of ['/', ...(selected.auth ? ['/login', '/register'] : [])]) {
        const response = await fetch(`${baseUrl}${route}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        const html = await response.text();
        if (response.status !== 200) throw new Error(`${route} returned ${response.status}: ${html.slice(0, 500)}`);
        if (/http:\/\/[^"<>\s]*\/build\//.test(html) || !/https:\/\/[^"<>\s]*\/build\//.test(html)) {
          throw new Error(`${route} must generate HTTPS asset URLs behind Railway's HTTP proxy.`);
        }
      }
    });
    if (!entry.redis) await check('forwarded-client-ip', () => smoke('session-ip'));
    await check('s3', () => smoke('s3'));
    const queue = await start('queue', images.queue, [...envOptions(env), ...mounts]);
    await check('queue', async () => {
      await smoke('dispatch');
      await waitFor(() => smoke('queue'), 60000);
    });
    const schedule = resolve(directory, 'console.php');
    writeFileSync(schedule, `${readFileSync(resolve(work, 'source', selected.id, 'routes/console.php'), 'utf8')}\n\\Illuminate\\Support\\Facades\\Schedule::call(function () { \\Illuminate\\Support\\Facades\\Cache::put('template-smoke-scheduler', 'ran', 300); })->everySecond();\n`);
    const scheduler = await start('scheduler', images.scheduler, [
      ...envOptions(env), ...mount(schedule, '/var/www/html/routes/console.php'),
    ]);
    await check('scheduler', async () => {
      await waitFor(() => smoke('scheduler'), 90000);
      for (const name of [queue, scheduler]) {
        const state = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', name], { capture: true })).stdout);
        if (!state.Running) throw new Error(`${name} stopped unexpectedly.`);
      }
    });
    await docker(['stop', '--time=3', queue, scheduler], { capture: true });

    await check('upstream-tests', async () => {
      const testEnv = { ...env, APP_ENV: 'testing', DB_DATABASE: 'laravel_test', DB_URL: env.DB_URL.replace(/\/laravel$/, '/laravel_test'), AUTORUN_ENABLED: 'false', PHP_MEMORY_LIMIT: '512M' };
      // Preserve the suite's queue/cache/session fakes; smoke checks above exercise
      // the deployed drivers. Only the database is replaced for the upstream suite.
      for (const key of ['CACHE_STORE', 'QUEUE_CONNECTION', 'SESSION_DRIVER']) delete testEnv[key];
      const name = `${prefix}-tests`;
      containers.push(name);
      const suite = await docker(['run', '--name', name, '--network', prefix, ...envOptions(testEnv),
        ...mount(fixture('prepare-tests.php'), '/tmp/prepare-tests.php'), '--entrypoint', 'sh', images.app, '-ec',
        'composer install --no-interaction --prefer-dist && php /tmp/prepare-tests.php && php vendor/bin/pest --configuration=.ci-phpunit.xml --colors=never',
      ], { capture: true, allowFailure: true });
      log('upstream-tests', suite.stdout + suite.stderr);
      if (suite.code !== 0) throw new Error(`Upstream tests failed. See ${directory}/upstream-tests.log\n${(suite.stdout + suite.stderr).slice(-5000)}`);
    });
    result.passed = true;
  } catch (error) {
    failures++;
    result.error = error.message;
    console.error(error.message);
  } finally {
    for (const container of containers) {
      const output = await docker(['logs', container], { capture: true, allowFailure: true });
      log(container, output.stdout + output.stderr);
      await docker(['rm', '--force', '--volumes', container], { capture: true, allowFailure: true });
    }
    if (networkCreated) await docker(['network', 'rm', prefix], { capture: true, allowFailure: true });
    result.finishedAt = new Date().toISOString();
    writeJson(resolve(work, 'results', `${selected.id}--${entry.backend}.json`), result);
    console.log(`[${selected.id}/${entry.backend}] ${result.passed ? 'PASS' : 'FAIL'}`);
  }
}
process.exitCode = failures ? 1 : 0;

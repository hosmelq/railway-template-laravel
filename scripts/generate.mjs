import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { identity, installer, mailNote, owner, readJson, root, run, sourceFiles, variant, work, writeJson } from './lib.mjs';

const selected = variant(process.argv[2]);
const app = resolve(work, 'apps', selected.id);
const output = resolve(work, 'source', selected.id);
const prepareExisting = process.argv.includes('--prepare-existing');

mkdirSync(resolve(work, 'apps'), { recursive: true });
// Chisel/Vite Plus honors ancestor .gitignore files before the installer initializes
// the application's repository. A Git boundary keeps /.work/ from hiding all inputs.
if (!existsSync(resolve(work, '.git'))) await run('git', ['init', '-q', '--initial-branch=main', work]);
if (!prepareExisting) {
  if (existsSync(app)) throw new Error(`Output already exists: ${app}. Move it aside before regenerating.`);
  await run(resolve(root, 'vendor/bin/laravel'), [
    'new', app, ...selected.flags, '--no-interaction', '--database=sqlite',
    '--pest', '--boost', '--npm', '--git', '--branch=main',
  ], { env: { ...identity, COMPOSER_NO_INTERACTION: '1' } });
}

// Skip the app's Composer scripts: in CI the kits' post-update `boost:update` fails because
// Boost writes no config when no coding agent is detected, and the scripts add nothing to the export.
await run('composer', ['require', 'league/flysystem-aws-s3-v3:^3.0', '--no-interaction', '--prefer-dist', '--no-scripts'], {
  cwd: app, env: { COMPOSER_NO_INTERACTION: '1' },
});
const bootstrapFile = resolve(app, 'bootstrap/app.php');
const bootstrap = readFileSync(bootstrapFile, 'utf8');
const middlewareAnchor = '->withMiddleware(function (Middleware $middleware): void {';
if (!bootstrap.includes(middlewareAnchor)) throw new Error('Missing middleware configuration anchor.');
const trustProxies = "$middleware->trustProxies(at: '*');";
if (!bootstrap.includes(trustProxies)) {
  writeFileSync(bootstrapFile, bootstrap.replace(
    /->withMiddleware\(function \(Middleware \$middleware\): void \{(?:\r?\n[ \t]*\/\/(?=\r?\n[ \t]*\}\)))?/,
    `${middlewareAnchor}\n        ${trustProxies}`,
  ));
}
await run('php', [resolve(root, 'scripts/assert-generated.php'), app, String(selected.auth)]);

cpSync(resolve(root, 'templates/docker'), resolve(app, 'docker'), { recursive: true });
copyFileSync(resolve(root, 'templates/.dockerignore'), resolve(app, '.dockerignore'));
const links = (readJson(resolve(root, 'data/templates.json'))[selected.id] ?? []).filter(({ url }) => url);
for (const link of links) {
  if (!/^https:\/\/railway\.(com|app)\//.test(link.url)) throw new Error(`Invalid Railway template URL: ${link.url}`);
}
const templateLinks = links.length ? `## Deploy on Railway\n\n${links.map(({ name, url }) => `- [${name}](${url})`).join('\n')}\n\n` : '';
const auth = selected.auth ? `## Authentication\n\nThe installer enables email verification, registration, two-factor authentication, passkeys, and password confirmation. To disable optional features, edit the features and options in \`config/fortify.php\`. To disable email verification, also remove \`MustVerifyEmail\` from the \`User\` model's implemented interfaces. Password confirmation is controlled by the \`confirmPassword\` options and the \`password.confirm\` middleware on protected routes in \`routes/settings.php\`. Update the affected pages and tests when changing these features.\n\n` : '';
writeFileSync(resolve(app, 'README.md'), readFileSync(resolve(root, 'templates/README.md'), 'utf8')
  .replaceAll('{{name}}', selected.name).replaceAll('{{repo}}', `${owner}/${selected.repo}`).replaceAll('{{directory}}', selected.repo)
  .replace('{{templates}}', templateLinks).replace('{{mail}}', mailNote(selected)).replace('{{authentication}}', auth));

const files = await sourceFiles(app);
const problems = [];
for (const file of files) {
  if (/^\.env(?:$|\.(?!example$))|(?:^|\/)database\.sqlite(?:$|-)|(?:^|\/)auth\.json$/.test(file)) problems.push(`${file}: local state would be published`);
  if (lstatSync(resolve(app, file)).isSymbolicLink()) {
    problems.push(`${file}: generated symlink requires inspection`);
    continue;
  }
  const content = readFileSync(resolve(app, file));
  if (/(?:^|\/)(?:\.?mcp|boost)\.json$/.test(file)) {
    const inspect = (value) => {
      if (typeof value === 'string' && /^(?:\/|[A-Z]:\\)/.test(value)) problems.push(`${file}: absolute path in agent configuration`);
      else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
    };
    inspect(JSON.parse(content.toString()));
  }
  if (!content.includes(0) && /\/(?:Users\/|home\/(?:runner|[^/\s]+)\/|opt\/homebrew\/|private\/var\/folders\/)|[A-Z]:\\Users\\/.test(content.toString())) {
    problems.push(`${file}: machine-specific absolute path`);
  }
}
const composer = readJson(resolve(app, 'composer.json'));
for (const packageName of ['laravel/boost', 'pestphp/pest', 'pestphp/pest-plugin-laravel']) {
  if (!composer['require-dev']?.[packageName]) problems.push(`Missing development dependency: ${packageName}`);
}
for (const packageName of Object.keys(composer.require)) {
  if (/octane|workos/.test(packageName)) problems.push(`Unexpected production dependency: ${packageName}`);
}
writeJson(resolve(work, 'reports', `${selected.id}-generation.json`), {
  variant: selected.id, installer, files: files.length, problems,
  ignoredLocalFiles: (await run('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.env', 'database/*.sqlite*', '.codex'], { cwd: app, capture: true })).stdout.split('\0').filter(Boolean),
});
if (problems.length) throw new Error(`Generated files need inspection:\n${problems.join('\n')}`);
if (existsSync(output)) throw new Error(`Export already exists: ${output}. Move it aside before preparing again.`);
for (const file of files) {
  mkdirSync(dirname(resolve(output, file)), { recursive: true });
  copyFileSync(resolve(app, file), resolve(output, file));
}

const lock = readJson(resolve(app, 'composer.lock'));
const npm = readJson(resolve(app, 'package-lock.json'));
writeJson(resolve(work, 'versions', `${selected.id}.json`), {
  variant: selected.id, installer, generatedAt: new Date().toISOString(),
  composer: Object.fromEntries([...lock.packages, ...lock['packages-dev']].map(({ name, version }) => [name, version]).sort()),
  npm: Object.fromEntries(Object.entries(npm.packages).filter(([name, value]) => name && value.version).map(([name, value]) => [name, value.version]).sort()),
});
console.log(`Prepared ${selected.id}: ${files.length} files in ${output}`);

# Laravel Railway application generator

Generate 14 official Laravel applications for 84 Railway template combinations: each application with MySQL, PostgreSQL or MariaDB, with or without Redis. This repository generates application source and Dockerfiles. Railway template definitions, repositories and publishing the Railway templates are managed separately.

## Catalog and pins

[`data/variants.json`](data/variants.json) is the single variant catalog used by every script and workflow. Its flags were checked against [`laravel/installer` v5.33.0 `NewCommand.php`](https://github.com/laravel/installer/blob/v5.33.0/src/NewCommand.php).

The generator pins the installer in `composer.json` and `composer.lock` and invokes `vendor/bin/laravel`. Non-interactive execution skips `interact()`, so the common flags explicitly preserve the interactive choices: `--database=sqlite --pest --boost --npm --git --branch=main`. Stack flags come only from the catalog. Authentication variants retain email verification, registration, two-factor authentication, passkeys and password confirmation. There is no WorkOS, Octane or SSR runtime.

| Component | Version |
| --- | --- |
| Laravel installer | 5.33.0 |
| APP image | `serversideup/php:8.5.12-frankenphp-v5.1.1` |
| Queue and Scheduler image | `serversideup/php:8.5.12-cli-v5.1.1` |
| Asset builder | `node:24.22.3-bookworm-slim` |
| MySQL | `mysql:9.4` |
| PostgreSQL | `postgres:18` |
| MariaDB LTS | `mariadb:11.8` |
| Redis | `redis:8.2` |
| Local S3 test server | `versity/versitygw:v1.11.0` |

PostgreSQL 18 matches the major used by [Railway's official PostgreSQL template](https://railway.com/template/postgres), checked on 2026-11-15. The harness uses the upstream PostgreSQL image; it does not exercise Railway's TLS wrapper. MariaDB 11.8 is an LTS series. ServerSideUp tags pin PHP's patch and the image release; backend tags retain the requested release series. `versions.json` records the exact Composer/npm versions resolved for each application and the latest workflow run. The installer is pinned; application packages intentionally refresh on regeneration.

## Local use

Requires PHP 8.5, Composer 2, Node 22.18+, 24.11+ or 26+, npm, Python 3 (standard-library artifact validation), Git, and a running Docker daemon with Compose-independent `docker` commands. No global Laravel installer is used.

```sh
composer install --no-interaction --prefer-dist
node scripts/matrix.mjs
node scripts/generate.mjs blade
node scripts/build.mjs blade
node scripts/test.mjs blade
```

Replace `blade` with any catalog ID. To run one backend, use `node scripts/test.mjs blade postgres-redis`; omit the backend for all six. To prepare an already generated app after a generation-only interruption, use `node scripts/generate.mjs blade --prepare-existing`.

Outputs are gitignored under `.work/`: full installer output in `apps/`, the publishable source in `source/`, package inventories in `versions/`, audit reports in `reports/`, backend results in `results/`, and runtime/test logs in `runs/`. Generation refuses to replace existing app or exported source directories; move old outputs aside before a fresh run. The installer initializes scratch Git repositories, but their commits are never pushed. A separate Git boundary in `.work/` prevents the parent ignore rule from hiding frontend sources from the installer's Chisel/Vite Plus hooks.

Each generated tree is exactly the installer output plus the S3 Composer adapter, `$middleware->trustProxies(at: '*');` in `bootstrap/app.php`, the three Dockerfiles, `.dockerignore`, and README. Exports honor the application's `.gitignore`. The generator audits the publishable files and stops on local `.env` files, SQLite databases, machine-specific absolute paths or unexpected symlinks; it never silently deletes installer files to pass that audit. Ignored local artifacts are listed in the generation report. Boost's agent selections can vary with the tools installed in the generation environment; its generated portable files are preserved.

## Runtime verification

The harness builds the three production images once per variant and reuses them for six backend cases. Every case has an isolated Docker network, database, optional Redis and local S3 service. No production services or credentials are used. The checks verify:

- Queue and Scheduler entrypoints leave a fresh database unmigrated.
- APP migrates it at startup and serves `/up`, `/`, and (for auth variants) `/login` and `/register` with HTTP 200.
- Trusted Railway proxy headers (`X-Forwarded-Proto: https` and `X-Forwarded-For: 203.0.113.10`) produce HTTPS asset URLs and record the forwarded client IP in database sessions.
- Database/cache/queue/session drivers match the supplied Railway-style variables; stderr uses the JSON formatter.
- A queued job actually runs in Queue, and a scheduled task actually runs in Scheduler.
- The `s3` disk writes and reads an object with virtual-hosted addressing.
- The application's original Pest suite passes against a separate `laravel_test` database on that backend. A temporary PHPUnit configuration changes only its database settings. Queue/cache/session test fakes remain the upstream defaults; the runtime checks exercise the real drivers.

Test-only job and scheduler fixtures are mounted into containers and never enter published source. Development dependencies are installed only in an ephemeral test container made from the APP image. Test containers and their anonymous volumes are removed after each case; images and logs remain for inspection. An interrupted/killed host process can leave its `laravel-test-*` containers/networks for manual cleanup.

The S3 fixture uses Versity Gateway because the formerly public MinIO container was unavailable when this harness was verified. It tests Laravel's S3 adapter, not Railway bucket credentials or policies. Current [Railway buckets](https://docs.railway.com/guides/storage-buckets) use virtual-hosted addressing; older buckets can require `AWS_USE_PATH_STYLE_ENDPOINT=true`, according to their Credentials tab.

## Monthly automation

`.github/workflows/regenerate.yml` runs at 03:17 UTC on the first of each month and on manual dispatch. The optional `variant` input accepts one catalog ID. A workflow-wide concurrency group serializes regenerations. Build jobs run at most four at a time; the test phase runs at most 14 jobs, below the 20-job limit. Each variant's three images are saved once as an artifact and loaded by its six test jobs; they are never published to a registry.

All variants finish testing before the publication phase. Publication checks each variant's own six results, so a failed variant does not prevent another passing variant from updating. It fetches the destination's existing `main`, replaces its tree, and creates one Conventional Commit. Identical trees produce no commit. Pushes are ordinary fast-forwards, never force pushes. In particular, the existing Livewire repository keeps all its history. A concurrent remote update rejects the push and is reported as a failure.

Planning failures maintain only the planning issue. After successful planning, failures open or update one issue per variant using `GITHUB_TOKEN`; a later successful run closes the issue. The final job records package inventories only for pushed or unchanged publications and commits only `versions.json` to this repository, with a fresh run timestamp even when no packages changed, preserving schedule activity. Logs/results remain artifacts for seven days and image artifacts for one day. Action dependencies in this generator workflow are pinned to commit SHAs. Generated starter-kit workflows remain the installer's original output.

Before enabling automation:

1. Create the public generator repository and all 14 destination repositories under `hosmelq`. Destinations may be empty or have a `main` branch; another existing branch is not silently replaced.
2. Add `VARIANTS_TOKEN`, a fine-grained PAT restricted to the 14 repositories with **Contents: write** and **Workflows: write**. Metadata read is implicit. The workflows permission is necessary because starter kits contain `.github/workflows`.
3. Allow `GITHUB_TOKEN` **Contents: write** and **Issues: write** for the final job in this repository, and enable Issues. Branch rules must allow the intended automation to update `main` in this repository and the variant repositories.
4. Publish Railway template definitions separately and fill in `data/templates.json`. Missing links are omitted from generated READMEs.

The template-link data format is:

```json
{
  "blade": [
    {
      "name": "MySQL with Redis",
      "url": "https://railway.com/template/your-template-code"
    }
  ]
}
```

Run `node --test tests/generator.test.mjs` for generator safety checks and `actionlint .github/workflows/regenerate.yml` for workflow validation. Generated production images also run `composer check-platform-reqs --no-dev` at build time. The image supplies MySQL/PostgreSQL PDO drivers, phpredis, OPcache and pcntl; the Dockerfiles retain the general-purpose `exif`, `gd`, and `intl` extensions. ServerSideUp [v5 automations](https://serversideup.net/open-source/docker-php/docs/laravel/laravel-automations) handle startup migrations and caching; only APP has migrations enabled.

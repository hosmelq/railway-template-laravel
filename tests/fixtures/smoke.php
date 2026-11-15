<?php

use Aws\S3\S3Client;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

function ensure(bool $value, string $message): void
{
    if (! $value) {
        throw new RuntimeException($message);
    }
}

switch ($argv[1]) {
    case 'database':
        ensure(DB::table('migrations')->count() > 0, 'APP did not run migrations.');
        ensure(config('database.default') === getenv('DB_CONNECTION'), 'Wrong database connection.');
        ensure(config('cache.default') === (getenv('REDIS_URL') ? 'redis' : 'database'), 'Wrong cache driver.');
        ensure(config('queue.default') === (getenv('REDIS_URL') ? 'redis' : 'database'), 'Wrong queue driver.');
        ensure(config('session.driver') === (getenv('REDIS_URL') ? 'redis' : 'database'), 'Wrong session driver.');
        Cache::put('template-smoke-cache', 'connected', 60);
        ensure(Cache::get('template-smoke-cache') === 'connected', 'Cache did not persist.');
        Log::info('template-smoke-json-log');
        break;

    case 'session-ip':
        ensure(DB::table('sessions')->where('ip_address', '203.0.113.10')->exists(), 'Sessions did not record the forwarded client IP.');
        ensure(! DB::table('sessions')->where('ip_address', '!=', '203.0.113.10')->exists(), 'Sessions recorded a proxy IP.');
        break;

    case 'dispatch':
        App\Jobs\TemplateSmokeJob::dispatch();
        break;

    case 'queue':
        ensure(Cache::get('template-smoke-queue') === 'processed', 'Queue has not processed the job.');
        break;

    case 'scheduler':
        ensure(Cache::get('template-smoke-scheduler') === 'ran', 'Scheduler has not run the task.');
        break;

    case 's3':
        $config = config('filesystems.disks.s3');
        $client = new S3Client([
            'version' => 'latest', 'region' => $config['region'], 'endpoint' => $config['endpoint'],
            'credentials' => ['key' => $config['key'], 'secret' => $config['secret']],
            'use_path_style_endpoint' => $config['use_path_style_endpoint'],
        ]);
        $client->createBucket(['Bucket' => $config['bucket']]);
        ensure(config('filesystems.default') === 's3', 'S3 is not the default disk.');
        ensure(Storage::disk('s3')->put('template-smoke.txt', 'stored'), 'S3 write failed.');
        ensure(Storage::disk('s3')->get('template-smoke.txt') === 'stored', 'S3 read failed.');
        Storage::disk('s3')->delete('template-smoke.txt');
        break;

    default:
        throw new RuntimeException('Unknown smoke check.');
}

echo "OK: {$argv[1]}\n";

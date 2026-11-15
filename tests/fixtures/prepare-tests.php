<?php

// Change only the database used by the upstream suite. Do not rewrite its tests.
// The upstream test bootstrap also expects a local environment file.
copy('.env.example', '.env');
$xml = new DOMDocument;
$xml->load('phpunit.xml');
$xpath = new DOMXPath($xml);
foreach (['DB_CONNECTION', 'DB_DATABASE', 'DB_URL'] as $name) {
    foreach ($xpath->query('/phpunit/php/env[@name="'.$name.'"]') as $node) {
        $node->parentNode->removeChild($node);
    }
    $node = $xml->createElement('env');
    $node->setAttribute('name', $name);
    $node->setAttribute('value', getenv($name));
    $node->setAttribute('force', 'true');
    $xml->getElementsByTagName('php')->item(0)->appendChild($node);
}
$xml->save('.ci-phpunit.xml');

require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$connection = Illuminate\Support\Facades\DB::connection();
if ($connection->getDatabaseName() !== 'laravel_test' || config('database.default') !== getenv('DB_CONNECTION')) {
    throw new RuntimeException('The upstream suite is not using the isolated backend database.');
}
echo 'Test database: '.config('database.default').' / '.$connection->getDatabaseName().PHP_EOL;

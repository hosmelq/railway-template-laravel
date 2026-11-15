<?php

use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Contracts\Console\Kernel;
use Laravel\Fortify\Features;

$directory = $argv[1];
$auth = $argv[2] === 'true';

require $directory.'/vendor/autoload.php';
$app = require $directory.'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

function check(bool $condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}

check(config('database.default') === 'sqlite', 'The installer must keep SQLite as the local default.');
check(config('mail.default') === 'log', 'The installer must keep log as the mail default.');
check(is_file($directory.'/tests/Pest.php'), 'Pest was not initialized.');
check(is_file($directory.'/boost.json'), 'Boost was not initialized.');
check(is_file($directory.'/package-lock.json'), 'npm did not produce a lockfile.');
check(is_file($directory.'/public/build/manifest.json'), 'The installer did not build frontend assets.');
check(str_contains(file_get_contents($directory.'/bootstrap/app.php'), '$middleware->trustProxies(at: \'*\');'), 'Railway proxies must be trusted.');

if ($auth) {
    foreach ([Features::registration(), Features::emailVerification(), Features::twoFactorAuthentication(), Features::passkeys()] as $feature) {
        check(Features::enabled($feature), 'Disabled auth feature: '.$feature);
    }

    check(is_subclass_of(App\Models\User::class, MustVerifyEmail::class), 'User must implement MustVerifyEmail.');
    check(config('fortify-options.two-factor-authentication.confirmPassword') === true, '2FA password confirmation must be enabled.');
    check(config('fortify-options.passkeys.confirmPassword') === true, 'Passkey password confirmation must be enabled.');
    check($app['router']->getRoutes()->getByName('password.confirm') !== null, 'Password confirmation must have a route.');
} else {
    check($app['router']->getRoutes()->getByName('login') === null, 'Unexpected authentication in a blank variant.');
}

echo "Installer defaults verified.\n";

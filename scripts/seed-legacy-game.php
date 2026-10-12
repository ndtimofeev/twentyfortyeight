<?php

declare(strict_types=1);

// Test-only setup for the disposable Nextcloud created by test-nextcloud.sh.
if (PHP_SAPI !== 'cli' || getenv('TFE_ISOLATED_TEST') !== '1') {
	throw new RuntimeException('This fixture requires an isolated integration-test container');
}

require dirname(__DIR__, 3) . '/lib/base.php';

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Db\ActiveGameMapper;
use OCA\TwentyFortyEight\Game\GameEngine;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\IUserManager;

$uid = 'smoke-legacy';
if (\OC::$server->get(IUserManager::class)->get($uid) === null) {
	throw new RuntimeException('Missing legacy test user');
}
$mapper = new ActiveGameMapper(\OC::$server->get(IDBConnection::class));
if ($mapper->findByUser($uid) !== null) {
	throw new RuntimeException('Legacy test user already has an active game');
}
$fixtures = json_decode(file_get_contents(dirname(__DIR__) . '/tests/fixtures/replay.json'), true, 512, JSON_THROW_ON_ERROR);
$fixture = null;
foreach ($fixtures as $candidate) {
	if ($candidate['name'] === 'v2-undo-first-full-banked') {
		$fixture = $candidate;
		break;
	}
}
if ($fixture === null) {
	throw new RuntimeException('Missing first-milestone fixture');
}

// Reproduce a genuine v1 proof, as an already installed 0.3.0 app issued it.
$config = \OC::$server->get(IConfig::class);
$encode = static fn (string $bytes): string => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
$payload = $encode(json_encode(['v' => 1, 's' => $fixture['seed'], 'iat' => time()], JSON_THROW_ON_ERROR));
$generation = $config->getAppValue(Application::APP_ID, hash('sha256', 'game_generation_' . $uid), '');
$signature = $encode(hash_hmac('sha256', Application::APP_ID . "\0" . $uid . "\0" . $generation . "\0" . $payload,
	(string)$config->getSystemValue('secret', ''), true));
$session = ['token' => $payload . '.' . $signature, 'seed' => $fixture['seed'], 'version' => 1];
$prefix = $fixture['actions'];
$serverEngine = new GameEngine($fixture['seed'], 1);
$serverEngine->replay($prefix);
$serverGame = ['session' => $session, 'actions' => $prefix, 'revision' => 4, 'state' => $serverEngine->savedState()];
if (!$mapper->insert($uid, $serverGame, time())) {
	throw new RuntimeException('Could not seed the old server game');
}

// Offline browser history is ahead of the server and has lost the full-cap reward.
$tail = [...$prefix, ['undo'], $prefix[count($prefix) - 1], ['undo']];
$oldEngine = new GameEngine($fixture['seed'], 1);
$oldEngine->replay($tail);
$local = $oldEngine->savedState();
$local['session'] = $session;
$local['actions'] = $tail;
$local['revision'] = 4;
$newEngine = new GameEngine($fixture['seed'], 2);
$newEngine->replay($tail);
$expected = $newEngine->savedState();
if ($local['bonuses']['undo'] !== 0 || $expected['bonuses']['undo'] !== 1
	|| $local['grid'] !== $expected['grid'] || $local['randomState'] !== $expected['randomState']) {
	throw new RuntimeException('Legacy fixture does not reproduce the missing reward');
}
echo json_encode(['localState' => $local, 'expectedState' => $expected], JSON_THROW_ON_ERROR);

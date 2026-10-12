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

$mapper = new ActiveGameMapper(\OC::$server->get(IDBConnection::class));
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

$config = \OC::$server->get(IConfig::class);
$encode = static fn (string $bytes): string => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
$prefix = $fixture['actions'];
$seed = $fixture['seed'];

/** Choose a genuine move that cannot earn an Undo reward under the new rules. */
function non128Move(int $seed, array $actions): array {
	for ($direction = 0; $direction < 4; $direction++) {
		$trial = [...$actions, ['move', $direction]];
		$engine = new GameEngine($seed, 2);
		try {
			$engine->replay($trial);
		} catch (InvalidArgumentException) {
			continue;
		}
		$has128 = false;
		foreach ($engine->savedState()['grid']['cells'] as $column) {
			foreach ($column as $tile) {
				if ($tile !== null && $tile['value'] >= 128) {
					$has128 = true;
				}
			}
		}
		if (!$has128) {
			return $trial;
		}
	}
	throw new RuntimeException('Could not create a non-128 move in the bank-dependent fixture');
}

$result = [];
foreach ([
	['version' => 1, 'username' => 'smoke-legacy'],
	['version' => 2, 'username' => 'smoke-legacy-v2'],
	['version' => 2, 'localVersion' => 1, 'username' => 'smoke-legacy-ancestor'],
] as $case) {
	$version = $case['version'];
	$localVersion = $case['localVersion'] ?? $version;
	$uid = $case['username'];
	if (\OC::$server->get(IUserManager::class)->get($uid) === null) {
		throw new RuntimeException('Missing legacy test user: ' . $uid);
	}
	if ($mapper->findByUser($uid) !== null) {
		throw new RuntimeException('Legacy test user already has an active game: ' . $uid);
	}
	// Reproduce the signed session format issued by the old application.
	$generation = $config->getAppValue(Application::APP_ID, hash('sha256', 'game_generation_' . $uid), '');
	$parent = null;
	$data = ['v' => $version, 's' => $seed, 'iat' => time()];
	if ($localVersion !== $version) {
		$parentPayload = $encode(json_encode(['v' => $localVersion, 's' => $seed, 'iat' => time()], JSON_THROW_ON_ERROR));
		$parentSignature = $encode(hash_hmac('sha256', Application::APP_ID . "\0" . $uid . "\0" . $generation . "\0" . $parentPayload,
			(string)$config->getSystemValue('secret', ''), true));
		$parent = ['token' => $parentPayload . '.' . $parentSignature, 'seed' => $seed, 'version' => $localVersion];
		// This is the genuine old v2 format: a signed link to its v1 parent.
		$data['p'] = $parent['token'];
	}
	$payload = $encode(json_encode($data, JSON_THROW_ON_ERROR));
	$signature = $encode(hash_hmac('sha256', Application::APP_ID . "\0" . $uid . "\0" . $generation . "\0" . $payload,
		(string)$config->getSystemValue('secret', ''), true));
	$session = ['token' => $payload . '.' . $signature, 'seed' => $seed, 'version' => $version];
	if ($parent !== null) {
		$session['previousToken'] = $parent['token'];
	}
	$serverEngine = new GameEngine($seed, $version);
	$serverEngine->replay($prefix);
	$serverState = $serverEngine->savedState();
	if ($version === 2 && $serverState['pendingBonuses']['undo'] !== 1) {
		throw new RuntimeException('The version-2 prefix must hold its old banked reward');
	}
	$serverGame = ['session' => $session, 'actions' => $prefix, 'revision' => 4, 'state' => $serverState];
	if (!$mapper->insert($uid, $serverGame, time())) {
		throw new RuntimeException('Could not seed the old server game');
	}

	if ($localVersion === 1) {
		$tail = [...$prefix, ['undo'], $prefix[count($prefix) - 1], ['undo']];
	} else {
		// The old reserve funds three Undos. None of the intervening moves makes
		// another 128, so switching to rule 3 before these offline actions is invalid.
		$tail = [...$prefix, ['undo']];
		for ($cycle = 0; $cycle < 2; $cycle++) {
			$tail = [...non128Move($seed, $tail), ['undo']];
		}
		try {
			(new GameEngine($seed, 3))->replay($tail);
			throw new RuntimeException('The old bank-dependent tail unexpectedly works under rule 3');
		} catch (InvalidArgumentException) {
			// The third Undo requires the old bank, so this is an actual cutover case.
		}
	}
	$oldEngine = new GameEngine($seed, $localVersion);
	$oldEngine->replay($tail);
	$local = $oldEngine->savedState();
	$canonicalEngine = new GameEngine($seed, $version);
	$canonicalEngine->replay($tail);
	$canonicalBefore = $canonicalEngine->savedState();
	$canonicalEngine->upgradeRules();
	$expected = $canonicalEngine->savedState();
	$expectedUndo = $parent === null ? 0 : 1;
	if ($local['bonuses']['undo'] !== 0 || $expected['bonuses']['undo'] !== $expectedUndo
		|| $expected['bonuses'] !== $canonicalBefore['bonuses']
		|| array_key_exists('pendingBonuses', $expected)
		|| $local['grid'] !== $expected['grid'] || $local['randomState'] !== $expected['randomState']) {
		throw new RuntimeException('The cutover must preserve old ready charges, board and RNG');
	}
	$local['session'] = $parent ?? $session;
	$local['actions'] = $tail;
	$local['revision'] = 4;
	$result[] = ['username' => $uid, 'localState' => $local, 'expectedState' => $expected];
}
echo json_encode(['fixtures' => $result], JSON_THROW_ON_ERROR);

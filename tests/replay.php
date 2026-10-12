<?php

declare(strict_types=1);

// Standalone tests: php tests/replay.php. No Nextcloud installation is required.
namespace OCP {
	interface IConfig {
		public function getSystemValue(string $key, mixed $default = ''): mixed;
		public function getAppValue(string $app, string $key, string $default = ''): string;
		public function setAppValue(string $app, string $key, string $value): void;
	}
}
namespace OCP\AppFramework\Utility {
	interface ITimeFactory {
		public function getTime(): int;
	}
}
namespace OCA\TwentyFortyEight\AppInfo {
	class Application {
		public const APP_ID = 'twentyfortyeight';
	}
}
namespace {
	use OCA\TwentyFortyEight\Game\GameEngine;
	use OCA\TwentyFortyEight\Game\GameSession;

	require __DIR__ . '/../lib/Game/GameEngine.php';
	require __DIR__ . '/../lib/Game/GameSession.php';

	$checks = 0;
	function same(mixed $expected, mixed $actual, string $message): void {
		global $checks;
		$checks++;
		if ($expected !== $actual) {
			throw new RuntimeException($message . "\nExpected: " . json_encode($expected) . "\nActual: " . json_encode($actual));
		}
	}
	function rejects(callable $fn, string $message): void {
		global $checks;
		$checks++;
		try {
			$fn();
		} catch (InvalidArgumentException) {
			return;
		}
		throw new RuntimeException('Expected rejection: ' . $message);
	}
	function set(GameEngine $game, string $property, mixed $value): void {
		$reflection = new ReflectionProperty($game, $property);
		$reflection->setAccessible(true);
		$reflection->setValue($game, $value);
	}
	function rows(array $rows): array {
		$columns = array_fill(0, 4, [0, 0, 0, 0]);
		foreach ($rows as $y => $row) {
			foreach ($row as $x => $value) {
				$columns[$x][$y] = $value;
			}
		}
		return $columns;
	}
	function onBoard(array $rows): GameEngine {
		$game = new GameEngine(1);
		set($game, 'board', rows($rows));
		return $game;
	}

	// Published xorshift32 vector, including a seed whose high bit is set.
	$game = new GameEngine(1);
	same([[2, 0, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], $game->state()['board'], 'Initial tiles use x-major order');
	same(307599695, $game->state()['rng'], 'First four RNG words for seed 1');
	$random = new ReflectionMethod($game, 'random');
	$random->setAccessible(true);
	foreach ([2398689233, 745495504, 632435482, 435756210, 2005365029, 2916098932] as $word) {
		same($word / 4294967296, $random->invoke($game), 'RNG word ' . $word);
	}
	$maxSeed = new GameEngine(0xffffffff);
	same(4056713434, $maxSeed->state()['rng'], 'High-bit seed is unsigned');
	same([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 2]], $maxSeed->state()['board'], 'Max seed initial tiles');
	foreach ([0, -1, 4294967296] as $seed) {
		rejects(fn() => new GameEngine($seed), 'Invalid seed ' . $seed);
	}

	$result = (new GameEngine(1))->replay([['move', 0], ['undo']]);
	same(4, $result['peakScore'], 'Undo preserves peak score');
	same(4, $result['bestTileEver'], 'Undo preserves peak tile');
	same(1, $result['movesAtPeakScore'], 'Peak score move count belongs to peak');
	same(0, $result['state']['score'], 'Undo restores current score');
	same(0, $result['state']['moves'], 'Undo restores current move count');
	same(745495504, $result['state']['rng'], 'Undo does not restore RNG');
	same(['undo' => 1, 'swap' => 2, 'remove' => 2], $result['state']['bonuses'], 'Undo charge is spent');
	same(false, $result['state']['canUndo'], 'Only one move can be undone');
	$result = (new GameEngine(1))->replay([['move', 0], ['undo'], ['move', 0]]);
	same(435756210, $result['state']['rng'], 'Redo consumes new random draws');
	same(1, $result['movesAtPeakScore'], 'Equal score does not rewrite peak moves');

	$result = (new GameEngine(1))->replay([['remove', 2]]);
	same(14, count(array_filter(array_merge(...$result['state']['board']), fn($v) => $v === 0)), 'Removing entire board respawns two tiles');
	same(435756210, $result['state']['rng'], 'Respawn consumes two pairs of draws');
	same(1, $result['state']['bonuses']['remove'], 'Remove charge spent');
	same(0, $result['state']['moves'], 'Remove is not a move');
	$result = (new GameEngine(1))->replay([['move', 0], ['swap', 0, 0, 0, 3]]);
	same(2, $result['state']['board'][0][0], 'Swap moves lower tile');
	same(4, $result['state']['board'][0][3], 'Swap moves larger tile');
	same(false, $result['state']['canUndo'], 'Swap invalidates previous move');
	same(745495504, $result['state']['rng'], 'Swap consumes no random draws');
	$result = (new GameEngine(1))->replay([['move', 0], ['remove', 4]]);
	same(4, $result['bestTileEver'], 'Removing largest tile preserves the record');
	same(false, $result['state']['canUndo'], 'Remove invalidates previous move');

	foreach ([['bogus'], ['move'], ['move', 4], ['move', '0'], ['move', 0, 1], ['undo', 0], ['continue'], ['remove', 8], ['remove', '2'], ['swap', 0, 0, 0, 2], ['swap', 0, 0, 0, 1], ['swap', -1, 0, 0, 2], ['swap', 0, 0, 4, 0], ['swap', 0, 0, 0, 0]] as $action) {
		rejects(fn() => (new GameEngine(1))->replay([$action]), 'Malformed or unavailable action: ' . json_encode($action));
	}
	rejects(fn() => (new GameEngine(1))->replay(['not an array']), 'Action must be an array');
	rejects(fn() => (new GameEngine(1))->replay([1 => ['move', 0]]), 'Action list must have sequential indexes');
	rejects(fn() => (new GameEngine(1))->replay([['move', 3]]), 'No-op move');
	rejects(fn() => (new GameEngine(1))->replay([['undo']]), 'Undo before a move');
	rejects(fn() => (new GameEngine(1))->replay([['move', 0], ['undo'], ['undo']]), 'Undo twice');
	rejects(fn() => (new GameEngine(1))->replay(array_fill(0, GameEngine::MAX_ACTIONS + 1, ['move', 0])), 'Replay CPU bound');

	$game = onBoard([[2, 2, 4, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
	$result = $game->replay([['move', 3]]);
	same(12, $result['peakScore'], 'Multiple merges count their resulting values');
	same([4, 8, 0, 0], array_column($result['state']['board'], 0), 'Each tile can merge only once');
	foreach ([[128, 'undo'], [256, 'swap'], [512, 'remove']] as [$value, $type]) {
		$game = onBoard([[intdiv($value, 2), intdiv($value, 2), 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
		set($game, 'bonuses', ['undo' => 1, 'swap' => 1, 'remove' => 1]);
		$result = $game->replay([['move', 3], ['undo'], ['move', 3]]);
		same($type === 'undo' ? 1 : 2, $result['state']['bonuses'][$type], 'Milestone charge cannot be farmed with Undo: ' . $type);
		same(true, $result['state']['reached']->{$value}, 'Milestone remembered');
	}
	$game = onBoard([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
	$result = $game->replay([['move', 3], ['continue'], ['undo']]);
	same(false, $result['state']['won'], 'Undo restores pre-win flag');
	same(true, $result['state']['keepPlaying'], 'Undo does not restore continuation flag');
	same(2048, $result['bestTileEver'], 'Peak tile remembered after undoing a win');
	rejects(fn() => onBoard([[1024, 1024, 0, 0]])->replay([['move', 3], ['move', 0]]), 'Moves blocked after a win');
	rejects(fn() => onBoard([[1024, 1024, 0, 0]])->replay([['move', 3], ['continue'], ['continue']]), 'Continuation logged only once');
	$lockedRows = [[2, 2, 4, 8], [16, 32, 64, 128], [256, 512, 1024, 2048], [4096, 8192, 16384, 32768]];
	rejects(fn() => onBoard($lockedRows)->replay([['swap', 0, 0, 3, 2]]), 'Swap that locks a full board');
	$game = onBoard([[8, 2, 8, 2], [2, 8, 2, 8], [4, 16, 4, 16], [32, 64, 128, 0]]);
	$result = $game->replay([['move', 1]]);
	same(true, $result['state']['over'], 'Last legal move detects game over');
	$result = $game->replay([['undo']]);
	same(false, $result['state']['over'], 'Undo may leave game over');

	$config = new class implements \OCP\IConfig {
		public string $secret = 'test-secret';
		private array $values = [];
		public function getSystemValue(string $key, mixed $default = ''): mixed {
			return $key === 'secret' ? $this->secret : $default;
		}
		public function getAppValue(string $app, string $key, string $default = ''): string {
			return $this->values[$app][$key] ?? $default;
		}
		public function setAppValue(string $app, string $key, string $value): void {
			$this->values[$app][$key] = $value;
		}
	};
	$time = new class implements \OCP\AppFramework\Utility\ITimeFactory {
		public int $now = 1_800_000_000;
		public function getTime(): int {
			return $this->now;
		}
	};
	$sessions = new GameSession($config, $time);
	$issued = $sessions->issue('alice');
	same(1, $issued['version'], 'Protocol version');
	same(true, $issued['seed'] >= 1 && $issued['seed'] <= 0xffffffff, 'Random seed fits unsigned 32 bits');
	$verified = $sessions->verify('alice', $issued['token'], []);
	same(json_encode((new GameEngine($issued['seed']))->replay([])), json_encode($verified), 'Valid signature replays the signed seed');
	same(false, array_key_exists('savedState', $verified), 'Default verification response remains unchanged');
	$restorable = $sessions->verify('alice', $issued['token'], [], true);
	same($issued, $restorable['session'], 'Restoration includes verified session metadata');
	same(json_encode((new GameEngine($issued['seed']))->savedState()), json_encode($restorable['savedState']), 'Verification can return the exact browser restoration state');
	unset($restorable['savedState'], $restorable['session']);
	same(json_encode($verified), json_encode($restorable), 'Opt-in restoration leaves replay statistics unchanged');
	rejects(fn() => $sessions->verify('bob', $issued['token'], []), 'Cannot submit someone else\'s session');
	rejects(fn() => $sessions->verify('alice', $issued['token'] . 'x', []), 'Tampered signature');
	rejects(fn() => $sessions->verify('alice', 'not-a-token', []), 'Malformed token');
	$config->secret = 'rotated-secret';
	rejects(fn() => $sessions->verify('alice', $issued['token'], []), 'Token from another instance or rotated key');
	$config->secret = 'test-secret';
	$time->now += GameSession::MAX_AGE;
	$sessions->verify('alice', $issued['token'], []);
	$time->now++;
	rejects(fn() => $sessions->verify('alice', $issued['token'], []), 'Expired session');
	$time->now = 1_800_000_000 - 301;
	rejects(fn() => $sessions->verify('alice', $issued['token'], []), 'Future-dated session');

	function tokenFor(array $data): string {
		$encode = fn($bytes) => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
		$payload = $encode(json_encode($data));
		return $payload . '.' . $encode(hash_hmac('sha256', "twentyfortyeight\0alice\0\0" . $payload, 'test-secret', true));
	}
	$time->now = 1_800_000_000;
	foreach ([['v' => 2, 's' => 1, 'iat' => $time->now], ['v' => 1, 's' => 0, 'iat' => $time->now], ['v' => 1, 's' => '1', 'iat' => $time->now], ['v' => 1, 's' => 1, 'iat' => (string)$time->now], ['v' => 1, 's' => 1, 'iat' => $time->now, 'extra' => true]] as $payload) {
		rejects(fn() => $sessions->verify('alice', tokenFor($payload), []), 'Signed payload still validates schema');
	}
	$sessions->revoke('bob');
	$sessions->verify('alice', $issued['token'], []);
	$sessions->revoke('alice');
	rejects(fn() => $sessions->verify('alice', $issued['token'], []), 'Deleted UID cannot reuse old game proofs');
	$renewed = $sessions->issue('alice');
	$sessions->verify('alice', $renewed['token'], []);
	$sessions->revoke('alice');
	rejects(fn() => $sessions->verify('alice', $renewed['token'], []), 'Repeated deletion revokes the newer generation too');

	// Fixtures generated by the real JavaScript classes, not a second rules copy.
	$fixtureFile = __DIR__ . '/fixtures/replay.json';
	if (!is_file($fixtureFile)) {
		throw new RuntimeException('Missing JavaScript replay fixtures: ' . $fixtureFile);
	}
	$fixtures = json_decode(file_get_contents($fixtureFile), true, 512, JSON_THROW_ON_ERROR);
	if (!is_array($fixtures) || count($fixtures) < 1) {
		throw new RuntimeException('JavaScript replay fixtures must not be empty');
	}
	foreach ($fixtures as $fixture) {
		$engine = new GameEngine($fixture['seed']);
		$actual = $engine->replay($fixture['actions']);
		// Decode reached into an array on both sides for JSON object comparison.
		$actual = json_decode(json_encode($actual, JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
		same($fixture['expected'], $actual, 'JavaScript parity: ' . $fixture['name']);
		$savedState = json_decode(json_encode($engine->savedState(), JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
		same($fixture['savedState'], $savedState, 'Browser restoration serialization parity: ' . $fixture['name']);
		if ($fixture['name'] === 'mixed-undo') {
			same(null, $savedState['previous'], 'An undone state cannot restore a second undo');
			same(4, $savedState['peakScore'], 'An undone board preserves the historical peak score');
			same(4, $savedState['maxTile'], 'An undone board preserves the historical maximum tile');
		}
		if ($fixture['name'] === 'mixed-merge') {
			same($fixtures[0]['savedState']['grid'], $savedState['previous']['grid'], 'Serialized undo snapshot restores the preceding browser grid');
			same(0, $savedState['previous']['score'], 'Undo snapshot preserves the preceding score');
		}
	}
	echo 'Replay checks passed: ' . $checks . "\n";
}

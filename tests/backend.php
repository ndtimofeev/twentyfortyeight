<?php

declare(strict_types=1);

// Run with: php tests/backend.php (requires pdo_sqlite).
require __DIR__ . '/fixtures/nextcloud.php';
require __DIR__ . '/fixtures/notifications.php';
foreach ([
	'Db/Score', 'Db/ScoreMapper', 'Db/ActiveGameMapper', 'AppInfo/Application',
	'Game/GameEngine', 'Game/GameSession', 'Service/LeaderboardService', 'Notification/Notifier',
	'Game/ActiveGameConflict', 'Game/ActiveGameService',
	'Controller/ScoreController', 'Controller/GameController', 'Listener/UserDeletedListener',
	'Migration/Version000100Date20261010000000', 'Migration/Version000200Date20261012000000',
	'Migration/Version000300Date20261012000000',
	'Migration/Version000600Date20261012000000', 'Migration/Version000700Date20261016000000', 'Migration/Version000701Date20261016000000',
] as $class) {
	require __DIR__ . '/../lib/' . $class . '.php';
}

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Controller\ScoreController;
use OCA\TwentyFortyEight\Controller\GameController;
use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCA\TwentyFortyEight\Db\ActiveGameMapper;
use OCA\TwentyFortyEight\Game\ActiveGameConflict;
use OCA\TwentyFortyEight\Game\ActiveGameService;
use OCA\TwentyFortyEight\Game\GameEngine;
use OCA\TwentyFortyEight\Game\GameSession;
use OCA\TwentyFortyEight\Listener\UserDeletedListener;
use OCA\TwentyFortyEight\Migration\Version000100Date20261010000000;
use OCA\TwentyFortyEight\Migration\Version000200Date20261012000000;
use OCA\TwentyFortyEight\Migration\Version000300Date20261012000000;
use OCA\TwentyFortyEight\Migration\Version000600Date20261012000000;
use TwentyFortyEightTests\Database;
use TwentyFortyEightTests\Clock;
use TwentyFortyEightTests\Config;
use TwentyFortyEightTests\DatabaseException;
use TwentyFortyEightTests\QueryBuilder;
use TwentyFortyEightTests\Schema;
use TwentyFortyEightTests\User;

if (!extension_loaded('pdo_sqlite')) {
	fwrite(STDERR, "Backend tests require the pdo_sqlite extension.\n");
	exit(1);
}

function same($expected, $actual): void {
	if ($expected !== $actual) {
		throw new RuntimeException('Expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
	}
}

function fixture(): array {
	$db = new Database();
	$schema = new Schema();
	$output = new class implements OCP\Migration\IOutput {};
	(new Version000100Date20261010000000())->changeSchema($output, fn () => $schema, []);
	(new Version000200Date20261012000000())->changeSchema($output, fn () => $schema, []);
	(new Version000300Date20261012000000())->changeSchema($output, fn () => $schema, []);
	(new Version000600Date20261012000000())->changeSchema($output, fn () => $schema, []);
	$migration = new \OCA\TwentyFortyEight\Migration\Version000700Date20261016000000($db);
	$migration->changeSchema($output, fn () => $schema, []);
	$schema->apply($db);
	$migration->postSchemaChange($output, fn () => $schema, []);
	$fix = new \OCA\TwentyFortyEight\Migration\Version000701Date20261016000000($db);
	$fix->changeSchema($output, fn () => $schema, []);
	$fix->postSchemaChange($output, fn () => $schema, []);
	return [$db, new ScoreMapper($db), $schema];
}

function record(ScoreMapper $mapper, string $uid): array {
	$entry = $mapper->findByUser($uid);
	if ($entry === null) { throw new RuntimeException('Missing record: ' . $uid); }
	return [$entry->getScore(), $entry->getBestTile(), $entry->getMoves(), $entry->getUpdatedAt()];
}

function controller(ScoreMapper $mapper, string $uid, ?GameSession $games = null): ScoreController {
	$session = new class($uid) implements OCP\IUserSession {
		public function __construct(private string $uid) {}
		public function getUser(): ?OCP\IUser { return new User($this->uid); }
	};
	$users = new class implements OCP\IUserManager {
		public function get(string $uid): ?OCP\IUser { return new User($uid); }
	};
	$clock = new Clock();
	$games ??= new GameSession(new Config(), $clock);
	return new ScoreController(new class implements OCP\IRequest {}, $mapper, $session, $users, $clock, $games, new \OCA\TwentyFortyEight\Service\LeaderboardService($mapper, new \TwentyFortyEightTests\Notifications(), new \TwentyFortyEightTests\Logger()));
}

function activeFixture(): array {
	[$db] = fixture();
	$mapper = new ActiveGameMapper($db);
	$clock = new Clock();
	$sessions = new GameSession(new Config(), $clock);
	return [$db, $mapper, $sessions, new ActiveGameService($mapper, $sessions, $clock), $clock];
}

function sameGame(?array $expected, ?array $actual): void {
	// Empty milestone maps are JSON objects, so compare their wire representation.
	same(json_encode($expected), json_encode($actual));
}

function conflict(callable $action): ActiveGameConflict {
	try {
		$action();
	} catch (ActiveGameConflict $e) {
		return $e;
	}
	throw new RuntimeException('Expected an active-game conflict');
}

function invalid(callable $action): void {
	try {
		$action();
	} catch (InvalidArgumentException) {
		return;
	}
	throw new RuntimeException('Expected an invalid game proof');
}

function sameCutoverState(array $legacy, array $current): void {
	// A rules cutover only discards the old reserve, preserving all ready charges.
	unset($legacy['pendingBonuses']);
	same(json_encode($legacy), json_encode($current));
}

function legalHistories(GameSession $sessions, string $uid, array $game): array {
	$histories = [];
	foreach ([0, 1, 2, 3] as $direction) {
		$actions = [...$game['actions'], ['move', $direction]];
		try {
			$sessions->verify($uid, $game['session']['token'], $actions);
			$histories[] = $actions;
		} catch (InvalidArgumentException) {
		}
	}
	if (count($histories) < 2) {
		throw new RuntimeException('Test setup needs two legal move histories');
	}
	return $histories;
}

function signedPayload(string $uid, array $payload): string {
	$encode = fn (string $bytes): string => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
	$body = $encode(json_encode($payload, JSON_THROW_ON_ERROR));
	return $body . '.' . $encode(hash_hmac('sha256', Application::APP_ID . "\0" . $uid . "\0\0" . $body, 'fixture-instance-secret', true));
}

function legacySession(string $uid, Clock $clock, int $seed = 42, int $version = 1): array {
	return ['token' => signedPayload($uid, ['v' => $version, 's' => $seed, 'iat' => $clock->now]), 'seed' => $seed, 'version' => $version];
}

function legacyBankHistory(): array {
	$fixtures = json_decode(file_get_contents(__DIR__ . '/fixtures/replay.json'), true, 512, JSON_THROW_ON_ERROR);
	$plan = null;
	foreach ($fixtures as $fixture) {
		if (($fixture['version'] ?? 1) === 1 && $fixture['seed'] === 42 && $fixture['expected']['state']['won']) {
			$plan = $fixture['actions'];
			break;
		}
	}
	if ($plan === null) { throw new RuntimeException('Missing genuine legacy win fixture'); }
	$engine = new OCA\TwentyFortyEight\Game\GameEngine(42, 1);
	$prefix = [];
	foreach ($plan as $action) {
		$prefix[] = $action;
		$result = $engine->replay([$action]);
		if (isset($result['state']['reached']->{'128'})) {
			same(2, $result['state']['bonuses']['undo']);
			// Undo twice after a full-cap award exposes the legacy lost reward.
			return [$prefix, [...$prefix, ['undo'], $action, ['undo'], $action]];
		}
	}
	throw new RuntimeException('Legacy fixture never reaches 128');
}

function bankDependentV2History(): array {
	[$prefix] = legacyBankHistory();
	$actions = [...$prefix, ['undo']];
	for ($cycle = 0; $cycle < 2; $cycle++) {
		$found = false;
		foreach ([0, 1, 2, 3] as $direction) {
			$trial = [...$actions, ['move', $direction]];
			$engine = new GameEngine(42, 2);
			try { $engine->replay($trial); } catch (InvalidArgumentException) { continue; }
			$has128 = false;
			foreach ($engine->state()['board'] as $column) {
				foreach ($column as $value) { $has128 = $has128 || $value >= 128; }
			}
			if (!$has128) {
				$actions = [...$trial, ['undo']];
				$found = true;
				break;
			}
		}
		if (!$found) { throw new RuntimeException('No non-128 move in bank-dependent fixture'); }
	}
	$old = (new GameEngine(42, 2))->replay($actions);
	same(0, $old['state']['bonuses']['undo']);
	invalid(fn () => (new GameEngine(42, 3))->replay($actions));
	return [$prefix, $actions];
}

function insertLegacy(ActiveGameMapper $mapper, GameSession $sessions, Clock $clock, array $actions, int $revision = 7, int $version = 1): array {
	$session = legacySession('alice', $clock, 42, $version);
	$verified = $sessions->verify('alice', $session['token'], $actions, true);
	$game = ['session' => $session, 'actions' => $actions, 'revision' => $revision, 'state' => $verified['savedState']];
	same(true, $mapper->insert('alice', $game, $clock->now));
	return $game;
}

$tests = [];
$tests['records retain independent score and tile maxima, and the moves/time of the score record'] = function (): void {
	[, $mapper] = fixture();
	$mapper->storeBest('alice', 100, 16, 10, 1);
	$mapper->storeBest('alice', 200, 8, 20, 2);
	same([200, 16, 20, 2], record($mapper, 'alice'));
	$mapper->storeBest('alice', 50, 64, 99, 3);
	$mapper->storeBest('alice', 200, 32, 999, 4);
	same([200, 64, 20, 2], record($mapper, 'alice'));
};

$tests['a delayed lower-score UPDATE cannot overwrite a competing higher score'] = function (): void {
	[$db, $mapper] = fixture();
	$mapper->storeBest('alice', 100, 16, 10, 1);
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $mapper): void {
		if ($qb->operation === 'update' && isset($qb->values['score'])) {
			$db->beforeExecute = null;
			$mapper->storeBest('alice', 300, 64, 30, 3);
		}
	};
	$mapper->storeBest('alice', 200, 32, 20, 2);
	same([300, 64, 30, 3], record($mapper, 'alice'));
};

$tests['a delayed tile UPDATE cannot overwrite a competing larger tile'] = function (): void {
	[$db, $mapper] = fixture();
	$mapper->storeBest('alice', 100, 16, 10, 1);
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $mapper): void {
		if ($qb->operation === 'update' && isset($qb->values['best_tile'])) {
			$db->beforeExecute = null;
			$mapper->storeBest('alice', 50, 128, 5, 3);
		}
	};
	$mapper->storeBest('alice', 200, 64, 20, 2);
	same([200, 128, 20, 2], record($mapper, 'alice'));
};

$tests['a first-insert collision retries both maxima without replacing the winning score stats'] = function (): void {
	[$db, $mapper] = fixture();
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $mapper): void {
		if ($qb->operation === 'insert') {
			$db->beforeExecute = null;
			$mapper->storeBest('alice', 700, 64, 70, 7);
		}
	};
	$mapper->storeBest('alice', 600, 128, 60, 6);
	same([700, 128, 70, 7], record($mapper, 'alice'));
	same(1, (int)$db->pdo->query('SELECT COUNT(*) FROM twentyfortyeight_records')->fetchColumn());
};

$tests['non-unique database failures propagate instead of being treated as insert races'] = function (): void {
	[$db, $mapper] = fixture();
	$db->beforeExecute = function (QueryBuilder $qb): void {
		if ($qb->operation === 'insert') { throw new DatabaseException(5); }
	};
	try {
		$mapper->storeBest('alice', 100, 16, 10, 1);
		throw new RuntimeException('Expected database failure');
	} catch (DatabaseException $e) {
		same(5, $e->getReason());
	}
};

$tests['competition ranks agree between the shared leaderboard and the personal place'] = function (): void {
	[, $mapper] = fixture();
	// Same timestamp, deliberately inserted in reverse UID order.
	$mapper->storeBest('bob', 500, 64, 10, 1);
	$mapper->storeBest('alice', 500, 64, 10, 1);
	$mapper->storeBest('carol', 300, 32, 10, 1);
	$data = controller($mapper, 'bob')->index()->getData();
	same(['alice', 'bob', 'carol'], array_column($data['leaderboard'], 'userId'));
	same([1, 1, 3], array_column($data['leaderboard'], 'rank'));
	same(1, $data['me']['rank']);
	same(3, controller($mapper, 'carol')->index()->getData()['me']['rank']);
};

$tests['the top 20 limit does not cap the personal rank'] = function (): void {
	[, $mapper] = fixture();
	for ($i = 1; $i <= 25; $i++) { $mapper->storeBest('user' . $i, $i * 100, 16, $i, $i); }
	$data = controller($mapper, 'user1')->index()->getData();
	same(20, count($data['leaderboard']));
	same(25, $data['me']['rank']);
};

$tests['the upgrade leaves legacy scores archived outside the verified ranking'] = function (): void {
	[$db, $mapper, $schema] = fixture();
	$db->pdo->exec("INSERT INTO twentyfortyeight_scores(user_id,score,best_tile,moves,updated_at) VALUES('legacy',4000000,131072,1,1)");
	same([], $mapper->findTop(20));
	$mapper->storeBest('alice', 100, 16, 10, 2);
	same(1, $mapper->rankOf($mapper->findByUser('alice')));
	same(4000000, (int)$db->pdo->query('SELECT score FROM twentyfortyeight_scores')->fetchColumn());
	$output = new class implements OCP\Migration\IOutput {};
	same(null, (new Version000200Date20261012000000())->changeSchema($output, fn () => $schema, []));
};

$tests['user deletion removes verified and legacy records and leaves other users intact'] = function (): void {
	[$db, $mapper] = fixture();
	$mapper->storeBest('alice', 100, 16, 10, 1);
	$mapper->storeBest('bob', 200, 32, 20, 2);
	$db->pdo->exec("INSERT INTO twentyfortyeight_scores(user_id,score) VALUES('alice',999),('bob',888)");
	$games = new GameSession(new Config(), new Clock());
	$token = $games->issue('alice')['token'];
	$bobToken = $games->issue('bob')['token'];
	$games->verify('alice', $token, []);
	$activeMapper = new ActiveGameMapper($db);
	$active = new ActiveGameService($activeMapper, $games, new Clock());
	$active->ensure('alice');
	$active->ensure('bob');
	$listener = new UserDeletedListener($mapper, $games, $activeMapper);
	$listener->handle(new OCP\EventDispatcher\Event());
	same([100, 16, 10, 1], record($mapper, 'alice'));
	$listener->handle(new OCP\User\Events\UserDeletedEvent(new User('alice')));
	try {
		$games->verify('alice', $token, []);
		throw new RuntimeException('A token issued before user deletion remains valid');
	} catch (InvalidArgumentException) {
	}
	$games->verify('bob', $bobToken, []);
	same(null, $mapper->findByUser('alice'));
	same(null, $active->get('alice'));
	same(true, $active->get('bob') !== null);
	same([200, 32, 20, 2], record($mapper, 'bob'));
	same(['bob'], $db->pdo->query('SELECT user_id FROM twentyfortyeight_scores')->fetchAll(PDO::FETCH_COLUMN));
	$mapper->storeBest('alice', 0, 2, 0, 3);
	same([0, 2, 0, 3], record($mapper, 'alice'));
};

$tests['score submission accepts only a verified replay and rejects another user or changed token'] = function (): void {
	[, $mapper] = fixture();
	$games = new GameSession(new Config(), new Clock());
	$proof = $games->issue('alice');
	$api = controller($mapper, 'alice', $games);
	$expected = $games->verify('alice', $proof['token'], []);
	$response = $api->submit($proof['token'], []);
	same(200, $response->getStatus());
	same([$expected['peakScore'], $expected['bestTileEver'], $expected['movesAtPeakScore'], (new Clock())->getTime()], record($mapper, 'alice'));
	same(400, controller($mapper, 'bob', $games)->submit($proof['token'], [])->getStatus());
	same(null, $mapper->findByUser('bob'));
	same(400, $api->submit('bad.token', [])->getStatus());
	same(400, $api->submit($proof['token'], [['type' => 'invented']])->getStatus());
	same([$expected['peakScore'], $expected['bestTileEver'], $expected['movesAtPeakScore'], (new Clock())->getTime()], record($mapper, 'alice'));
};

$tests['submission stores the verified peak after Undo and an older proof cannot lower it'] = function (): void {
	[, $mapper] = fixture();
	$games = new GameSession(new Config(), new Clock());
	$token = $games->issue('alice')['token'];
	$actions = [];
	$stats = $games->verify('alice', $token, $actions);
	// Build a legal game from the signed seed without assuming random positions.
	for ($step = 0; $step < 100 && $stats['peakScore'] === 0; $step++) {
		foreach ([0, 1, 2, 3] as $direction) {
			$candidate = [...$actions, ['move', $direction]];
			try {
				$stats = $games->verify('alice', $token, $candidate);
				$actions = $candidate;
				break;
			} catch (InvalidArgumentException) {
			}
		}
	}
	if ($stats['peakScore'] <= 0) { throw new RuntimeException('Could not build a scoring game'); }
	$actions[] = ['undo'];
	$undone = $games->verify('alice', $token, $actions);
	if ($undone['state']['score'] >= $undone['peakScore']) { throw new RuntimeException('Undo did not lower current score'); }
	$api = controller($mapper, 'alice', $games);
	same(200, $api->submit($token, $actions)->getStatus());
	$expected = [$undone['peakScore'], $undone['bestTileEver'], $undone['movesAtPeakScore'], (new Clock())->getTime()];
	same($expected, record($mapper, 'alice'));
	same(200, $api->submit($token, [])->getStatus());
	same($expected, record($mapper, 'alice'));
};

$tests['user identifiers are bound parameters for inserts, lookups, updates and deletes'] = function (): void {
	[, $mapper] = fixture();
	$uid = "x' OR 1=1 --";
	$mapper->storeBest('alice', 100, 16, 10, 1);
	$mapper->storeBest($uid, 200, 32, 20, 2);
	$mapper->storeBest($uid, 300, 64, 30, 3);
	$mapper->deleteByUser($uid);
	same(null, $mapper->findByUser($uid));
	same([100, 16, 10, 1], record($mapper, 'alice'));
};

$tests['active games start once and reconstruct the entire verified state on another device'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	same(null, $service->get('alice'));
	$created = $service->ensure('alice');
	same(0, $created['revision']);
	same([], $created['actions']);
	sameGame($created, $service->ensure('alice'));
	$history = legalHistories($sessions, 'alice', $created)[0];
	$saved = $service->save('alice', $created['session']['token'], $history, 0);
	same(1, $saved['revision']);
	$verified = $sessions->verify('alice', $created['session']['token'], $history, true);
	same(json_encode($verified['savedState']), json_encode($saved['state']));
	$anotherDevice = new ActiveGameService($mapper, $sessions, $clock);
	sameGame($saved, $anotherDevice->get('alice'));
	sameGame($saved, $anotherDevice->ensure('alice'));
	foreach (['grid', 'score', 'moves', 'over', 'won', 'keepPlaying', 'maxTile', 'peakScore', 'bonuses', 'reached', 'previous', 'randomState'] as $field) {
		same(true, array_key_exists($field, $saved['state']));
	}
};

$tests['old local signed games can be adopted only into an empty active slot at revision zero'] = function (): void {
	[, , $sessions, $service] = activeFixture();
	$session = $sessions->issue('alice');
	$local = ['session' => $session, 'actions' => []];
	$history = legalHistories($sessions, 'alice', $local)[0];
	$adopted = $service->save('alice', $session['token'], $history, 0);
	same(0, $adopted['revision']);
	same($history, $adopted['actions']);
	sameGame($adopted, $service->get('alice'));
	$bob = $sessions->issue('bob');
	same(null, conflict(fn () => $service->save('bob', $bob['token'], [], 4))->game);
	same(null, $service->get('bob'));
};

$tests['stale equal-history retries are idempotent but truncated or divergent histories conflict'] = function (): void {
	[, , $sessions, $service] = activeFixture();
	$created = $service->ensure('alice');
	[$first, $different] = legalHistories($sessions, 'alice', $created);
	$saved = $service->save('alice', $created['session']['token'], $first, 0);
	sameGame($saved, $service->save('alice', $created['session']['token'], $first, 0));
	sameGame($saved, conflict(fn () => $service->save('alice', $created['session']['token'], [], 1))->game);
	sameGame($saved, conflict(fn () => $service->save('alice', $created['session']['token'], $different, 1))->game);
	$extension = legalHistories($sessions, 'alice', $saved)[0];
	sameGame($saved, conflict(fn () => $service->save('alice', $created['session']['token'], $extension, 0))->game);
	$newest = $service->save('alice', $created['session']['token'], $extension, 1);
	same(2, $newest['revision']);
	sameGame($newest, $service->get('alice'));
};

$tests['a competing device cannot overwrite a newer history between read and conditional UPDATE'] = function (): void {
	[$db, , $sessions, $service] = activeFixture();
	$created = $service->ensure('alice');
	[$delayed, $winning] = legalHistories($sessions, 'alice', $created);
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, $created, $winning, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$winner = $service->save('alice', $created['session']['token'], $winning, 0);
		}
	};
	$error = conflict(fn () => $service->save('alice', $created['session']['token'], $delayed, 0));
	sameGame($winner, $error->game);
	sameGame($winner, $service->get('alice'));
};

$tests['identical concurrent saves succeed with one revision instead of producing false conflicts'] = function (): void {
	[$db, , $sessions, $service] = activeFixture();
	$created = $service->ensure('alice');
	$history = legalHistories($sessions, 'alice', $created)[0];
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, $created, $history, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$winner = $service->save('alice', $created['session']['token'], $history, 0);
		}
	};
	$saved = $service->save('alice', $created['session']['token'], $history, 0);
	same(1, $saved['revision']);
	sameGame($winner, $saved);
};

$tests['two initial creates return the insert winner and an adoption race never overwrites it'] = function (): void {
	[$db, , $sessions, $service] = activeFixture();
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'insert') {
			$db->beforeExecute = null;
			$winner = $service->ensure('alice');
		}
	};
	sameGame($service->ensure('alice'), $winner);
	$oldLocal = $sessions->issue('bob');
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'insert') {
			$db->beforeExecute = null;
			$winner = $service->ensure('bob');
		}
	};
	$error = conflict(fn () => $service->save('bob', $oldLocal['token'], [], 0));
	sameGame($winner, $error->game);
	sameGame($winner, $service->get('bob'));
};

$tests['restart creates a fresh token and rejects delayed saves from the previous game'] = function (): void {
	[, , $sessions, $service] = activeFixture();
	$previous = $service->ensure('alice');
	$history = legalHistories($sessions, 'alice', $previous)[0];
	$fresh = $service->ensure('alice', true);
	same(false, $previous['session']['token'] === $fresh['session']['token']);
	same(0, $fresh['revision']);
	same([], $fresh['actions']);
	sameGame($fresh, conflict(fn () => $service->save('alice', $previous['session']['token'], $history, 0))->game);
	sameGame($fresh, $service->get('alice'));
};

$tests['a restart racing with a pending old UPDATE protects the new token even at the same revision'] = function (): void {
	[$db, , $sessions, $service] = activeFixture();
	$previous = $service->ensure('alice');
	$history = legalHistories($sessions, 'alice', $previous)[0];
	$fresh = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, &$fresh): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$fresh = $service->ensure('alice', true);
		}
	};
	$error = conflict(fn () => $service->save('alice', $previous['session']['token'], $history, 0));
	sameGame($fresh, $error->game);
	sameGame($fresh, $service->get('alice'));
};

$tests['active saves reject another user, invalid actions and invalid revisions without changing data'] = function (): void {
	[, , , $service] = activeFixture();
	$alice = $service->ensure('alice');
	$bob = $service->ensure('bob');
	foreach ([['bob', $alice['session']['token'], [], 0], ['alice', $alice['session']['token'], [['move', 4]], 0], ['alice', $alice['session']['token'], [], -1]] as $arguments) {
		try {
			$service->save(...$arguments);
			throw new RuntimeException('Invalid save was accepted');
		} catch (InvalidArgumentException) {
		}
	}
	sameGame($alice, $service->get('alice'));
	sameGame($bob, $service->get('bob'));
};

$tests['expired active games become absent and fresh games can be created'] = function (): void {
	[, $mapper, , $service, $clock] = activeFixture();
	$expired = $service->ensure('alice');
	$clock->now += GameSession::MAX_AGE + 1;
	same(null, $service->get('alice'));
	same(null, $mapper->findByUser('alice'));
	$fresh = $service->ensure('alice');
	same(false, $expired['session']['token'] === $fresh['session']['token']);
	sameGame($fresh, $service->get('alice'));
};

$tests['expiry cleanup cannot delete a concurrently created replacement game'] = function (): void {
	[$db, , , $service, $clock] = activeFixture();
	$service->ensure('alice');
	$clock->now += GameSession::MAX_AGE + 1;
	$fresh = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, &$fresh): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'delete') {
			$db->beforeExecute = null;
			$fresh = $service->ensure('alice', true);
		}
	};
	$loaded = $service->get('alice');
	sameGame($fresh, $loaded);
	sameGame($fresh, $service->get('alice'));
};

$tests['active-game API wraps state consistently and returns the latest game with conflicts'] = function (): void {
	[, , $sessions, $service] = activeFixture();
	$userSession = new class implements OCP\IUserSession {
		public function getUser(): ?OCP\IUser { return new User('alice'); }
	};
	$api = new GameController(new class implements OCP\IRequest {}, $service, $userSession);
	same(['game' => null], $api->index()->getData());
	$created = $api->create()->getData()['game'];
	$history = legalHistories($sessions, 'alice', $created)[0];
	$response = $api->save($created['session']['token'], $history, 0);
	same(200, $response->getStatus());
	$saved = $response->getData()['game'];
	sameGame($saved, $api->index()->getData()['game']);
	$bad = $api->save($created['session']['token'], [], 1);
	same(409, $bad->getStatus());
	sameGame($saved, $bad->getData()['game']);
	same(400, $api->save('forged.token', [], 1)->getStatus());
	$fresh = $api->create(true)->getData()['game'];
	same(false, $fresh['session']['token'] === $created['session']['token']);
};

$tests['active-game migration is idempotent and stores large histories and states as text'] = function (): void {
	[, , $schema] = fixture();
	$output = new class implements OCP\Migration\IOutput {};
	same(null, (new Version000300Date20261012000000())->changeSchema($output, fn () => $schema, []));
	same('text', $schema->tables['twentyfortyeight_games']->columns['actions'][0]);
	same('text', $schema->tables['twentyfortyeight_games']->columns['state'][0]);
	same([['user_id'], true], $schema->tables['twentyfortyeight_games']->indexes['tfe_games_user_idx']);
};

$tests['new games use v4 while legacy score proofs and cutover counters keep their original behavior'] = function (): void {
	[, $mapper] = fixture();
	$clock = new Clock();
	$sessions = new GameSession(new Config(), $clock);
	$fresh = $sessions->issue('alice');
	same(5, $fresh['version']);
	same(false, array_key_exists('previousToken', $fresh));
	same(false, array_key_exists('pendingBonuses', $sessions->verify('alice', $fresh['token'], [], true)['savedState']));
	foreach ([1, 2] as $version) {
		[, $actions] = $version === 1 ? legacyBankHistory() : bankDependentV2History();
		$legacy = legacySession('alice', $clock, 42, $version);
		$old = $sessions->verify('alice', $legacy['token'], $actions, true);
		same($version, $old['session']['version']);
		same(0, $old['savedState']['bonuses']['undo']);
		$new = $sessions->upgrade('alice', $legacy['token'], $actions);
		same(5, $new['version']);
		same(42, $new['seed']);
		same($legacy['token'], $new['previousToken']);
		same(count($actions), $new['cutover']);
		$current = $sessions->verify('alice', $new['token'], $actions, true);
		sameCutoverState($old['savedState'], $current['savedState']);
		foreach (['peakScore', 'bestTileEver', 'movesAtPeakScore'] as $field) { same($old[$field], $current[$field]); }
		same(json_encode($old), json_encode($sessions->verify('alice', $legacy['token'], $actions, true)));
		$api = controller($mapper, 'alice', $sessions);
		same(200, $api->submit($legacy['token'], $actions)->getStatus());
		same([$old['peakScore'], $old['bestTileEver'], $old['movesAtPeakScore'], $clock->now], record($mapper, 'alice'));
		same(200, $api->submit($new['token'], $actions)->getStatus());
		same([$old['peakScore'], $old['bestTileEver'], $old['movesAtPeakScore'], $clock->now], record($mapper, 'alice'));
	}
};

$tests['legacy v2-with-v1-parent sessions remain valid and upgrade to bounded direct-parent v4 tokens'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	$parent = legacySession('alice', $clock);
	$token = signedPayload('alice', ['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $parent['token']]);
	[, $actions] = bankDependentV2History();
	$legacy = $sessions->verify('alice', $token, $actions, true);
	same(2, $legacy['session']['version']);
	same($parent['token'], $legacy['session']['previousToken']);
	same(false, array_key_exists('cutover', $legacy['session']));
	$upgraded = $sessions->upgrade('alice', $token, $actions);
	same(5, $upgraded['version']);
	same($token, $upgraded['previousToken']);
	same([$parent['token']], $upgraded['ancestorTokens']);
	same(count($actions), $upgraded['cutover']);
	same(true, strlen($upgraded['token']) <= 512);
	same($upgraded, $sessions->session('alice', $upgraded['token']));
	sameCutoverState($legacy['savedState'], $sessions->verify('alice', $upgraded['token'], $actions, true)['savedState']);
	invalid(fn () => $sessions->upgrade('alice', $upgraded['token'], $actions));
};

$tests['a signed cutover preserves the old prefix and awards repeated milestones in its current-rules suffix'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	[$prefix] = legacyBankHistory();
	$legacy = legacySession('alice', $clock);
	$upgraded = $sessions->upgrade('alice', $legacy['token'], $prefix);
	$actions = [...$prefix, ['undo'], $prefix[count($prefix) - 1]];
	$old = $sessions->verify('alice', $legacy['token'], $actions, true);
	$current = $sessions->verify('alice', $upgraded['token'], $actions, true);
	same(count($prefix), $current['session']['cutover']);
	same(1, $old['savedState']['bonuses']['undo']);
	same(2, $current['savedState']['bonuses']['undo']);
	same(json_encode($old['savedState']['grid']), json_encode($current['savedState']['grid']));
	same($old['savedState']['randomState'], $current['savedState']['randomState']);
	same(true, isset($current['savedState']['reached']->{'128'}));
	same(false, array_key_exists('pendingBonuses', $current['savedState']));
};

$tests['versioned metadata rejects malformed cutovers parent shapes foreign users and seeds'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	$parent = legacySession('alice', $clock);
	$upgraded = $sessions->upgrade('alice', $parent['token'], []);
	same($upgraded, $sessions->session('alice', $upgraded['token']));
	$base = ['v' => 3, 's' => 42, 'iat' => $clock->now];
	$foreign = legacySession('bob', $clock);
	$otherSeed = legacySession('alice', $clock, 1);
	$cases = [
		[...$base, 'n' => 0],
		[...$base, 'p' => $parent['token']],
		[...$base, 'p' => null, 'n' => 0],
		[...$base, 'p' => 'forged.parent', 'n' => 0],
		[...$base, 'p' => $foreign['token'], 'n' => 0],
		[...$base, 'p' => $otherSeed['token'], 'n' => 0],
		[...$base, 'p' => $upgraded['token'], 'n' => 0],
		[...$base, 'p' => $parent['token'], 'n' => 0, 'extra' => true],
		['v' => 1, 's' => 42, 'iat' => $clock->now, 'p' => $parent['token']],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $parent['token'], 'n' => 0],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => null],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $upgraded['token']],
		['v' => 6, 's' => 42, 'iat' => $clock->now],
	];
	foreach ([-1, true, false, 0.5, '0', null, GameEngine::MAX_ACTIONS + 1] as $cutover) {
		$cases[] = [...$base, 'p' => $parent['token'], 'n' => $cutover];
	}
	foreach ($cases as $payload) {
		$token = signedPayload('alice', $payload);
		invalid(fn () => $sessions->session('alice', $token));
		invalid(fn () => $sessions->verify('alice', $token, []));
	}
	// A signed maximum cutover is valid metadata; it still requires a full proof.
	$maximum = signedPayload('alice', [...$base, 'p' => $parent['token'], 'n' => GameEngine::MAX_ACTIONS]);
	same(GameEngine::MAX_ACTIONS, $sessions->session('alice', $maximum)['cutover']);
	invalid(fn () => $sessions->verify('alice', $maximum, []));
};

$tests['cutover replays reject truncated non-list and globally oversized histories before slicing'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	[$prefix] = legacyBankHistory();
	$legacy = legacySession('alice', $clock);
	$upgraded = $sessions->upgrade('alice', $legacy['token'], $prefix);
	// Loading metadata does not replay or require the history.
	same($upgraded, $sessions->session('alice', $upgraded['token']));
	invalid(fn () => $sessions->verify('alice', $upgraded['token'], array_slice($prefix, 0, -1)));
	invalid(fn () => $sessions->verify('alice', $upgraded['token'], [1 => ['move', 0]]));
	$tooLong = array_fill(0, GameEngine::MAX_ACTIONS + 1, ['move', 0]);
	invalid(fn () => $sessions->verify('alice', $upgraded['token'], $tooLong));
	invalid(fn () => $sessions->extendUpgrade('alice', $upgraded['token'], $legacy['token'], $tooLong));
	invalid(fn () => $sessions->upgrade('alice', $legacy['token'], [1 => ['move', 0]]));
	invalid(fn () => $sessions->upgrade('alice', $legacy['token'], $tooLong));
};

$tests['a renewed child keeps its own age but deletion revokes the child and its legacy ancestry'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	$parent = legacySession('alice', $clock);
	$clock->now += GameSession::MAX_AGE;
	$renewed = $sessions->upgrade('alice', $parent['token'], []);
	$clock->now++;
	$sessions->verify('alice', $renewed['token'], []);
	invalid(fn () => $sessions->upgrade('alice', $parent['token'], []));
	$extended = $sessions->extendUpgrade('alice', $renewed['token'], $parent['token'], [['move', 0]]);
	$sessions->verify('alice', $extended['token'], [['move', 0]]);
	$sessions->revoke('alice');
	invalid(fn () => $sessions->verify('alice', $renewed['token'], []));
	invalid(fn () => $sessions->verify('alice', $extended['token'], [['move', 0]]));
};

$tests['loading v1 and v2 active games upgrades once and preserves every state field except the old reserve'] = function (): void {
	foreach ([1, 2] as $version) {
		[, $mapper, $sessions, $service, $clock] = activeFixture();
		[$prefix, $full] = legacyBankHistory();
		$actions = $version === 1 ? $full : $prefix;
		$legacy = insertLegacy($mapper, $sessions, $clock, $actions, 7, $version);
		if ($version === 1) { same(0, $legacy['state']['bonuses']['undo']); }
		else { same(1, $legacy['state']['pendingBonuses']['undo']); }
		$upgraded = $service->get('alice');
		same(5, $upgraded['session']['version']);
		same($legacy['session']['token'], $upgraded['session']['previousToken']);
		same(count($actions), $upgraded['session']['cutover']);
		same(8, $upgraded['revision']);
		same($actions, $upgraded['actions']);
		sameCutoverState($legacy['state'], $upgraded['state']);
		sameGame($upgraded, $service->get('alice'));
		sameGame($upgraded, $service->ensure('alice'));
		sameGame($upgraded, conflict(fn () => $service->save('alice', $legacy['session']['token'], $actions, 7))->game);
		same($upgraded['session']['token'], $mapper->findByUser('alice')['session_token']);
	}
};

$tests['offline v1 and bank-dependent v2 tails promote under their original rules with a new signed cutover'] = function (): void {
	foreach ([1, 2] as $version) {
		[, $mapper, $sessions, $service, $clock] = activeFixture();
		[$prefix, $full] = $version === 1 ? legacyBankHistory() : bankDependentV2History();
		$legacy = insertLegacy($mapper, $sessions, $clock, $prefix, 7, $version);
		$upgraded = $service->get('alice');
		if ($version === 2) {
			invalid(fn () => $sessions->verify('alice', $upgraded['session']['token'], $full));
			invalid(fn () => $service->save('alice', $upgraded['session']['token'], $full, 8));
		}
		$saved = $service->save('alice', $upgraded['session']['token'], $full, 8, $legacy['session']['token']);
		same(9, $saved['revision']);
		same($full, $saved['actions']);
		same(count($full), $saved['session']['cutover']);
		same($legacy['session']['token'], $saved['session']['previousToken']);
		same(false, $upgraded['session']['token'] === $saved['session']['token']);
		same(0, $saved['state']['bonuses']['undo']);
		$old = $sessions->verify('alice', $legacy['session']['token'], $full, true);
		sameCutoverState($old['savedState'], $saved['state']);
		sameCutoverState($old['savedState'], $sessions->verify('alice', $saved['session']['token'], $full, true)['savedState']);
		// Both an old child token after a lost ACK and the current token retry idempotently.
		sameGame($saved, $service->save('alice', $upgraded['session']['token'], $full, 8, $legacy['session']['token']));
		sameGame($saved, $service->save('alice', $saved['session']['token'], $full, 8, $legacy['session']['token']));
		sameGame($saved, $service->get('alice'));
	}
};

$tests['promotion validates the complete old history rather than accepting a tail legal only under v3'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = legacyBankHistory();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix);
	$upgraded = $service->get('alice');
	$invalidOldTail = [...$full, ['undo']];
	// Repeated 128 rewards make this valid in v3, but the legacy client had no Undo left.
	$sessions->verify('alice', $upgraded['session']['token'], $invalidOldTail);
	invalid(fn () => $sessions->verify('alice', $legacy['session']['token'], $invalidOldTail));
	invalid(fn () => $service->save('alice', $upgraded['session']['token'], $invalidOldTail, 8, $legacy['session']['token']));
	sameGame($upgraded, $service->get('alice'));
};

$tests['promotion requires the direct linked parent and rejects foreign parents ancestors and stale branches'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = bankDependentV2History();
	$ancestor = legacySession('alice', $clock);
	$parent = ['token' => signedPayload('alice', ['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $ancestor['token']]), 'seed' => 42, 'version' => 2];
	$verified = $sessions->verify('alice', $parent['token'], $prefix, true);
	$legacy = ['session' => $parent, 'actions' => $prefix, 'revision' => 7, 'state' => $verified['savedState']];
	same(true, $mapper->insert('alice', $legacy, $clock->now));
	$upgraded = $service->get('alice');
	same([$ancestor['token']], $upgraded['session']['ancestorTokens']);
	foreach ([$ancestor['token'], legacySession('bob', $clock)['token'], 'forged.parent'] as $wrongParent) {
		invalid(fn () => $service->save('alice', $upgraded['session']['token'], $full, 8, $wrongParent));
	}
	$otherParent = legacySession('alice', $clock, 1, 2);
	$otherChild = $sessions->upgrade('alice', $otherParent['token'], []);
	sameGame($upgraded, conflict(fn () => $service->save('alice', $otherChild['token'], [], 8, $otherParent['token']))->game);
	sameGame($upgraded, conflict(fn () => $service->save('alice', $upgraded['session']['token'], $full, 7, $parent['token']))->game);
	invalid(fn () => $service->save('alice', $upgraded['session']['token'], array_slice($prefix, 0, -1), 8, $parent['token']));
	invalid(fn () => $service->save('alice', $upgraded['session']['token'], [1 => ['move', 0]], 8, $parent['token']));
	invalid(fn () => $service->save('alice', $upgraded['session']['token'], array_fill(0, GameEngine::MAX_ACTIONS + 1, ['move', 0]), 8, $parent['token']));
	sameGame($upgraded, $service->get('alice'));
};

$tests['a v1 ancestor tail can be promoted using its direct v2 parent while preserving canonical v2 counters'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = legacyBankHistory();
	$ancestor = legacySession('alice', $clock);
	$token = signedPayload('alice', ['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $ancestor['token']]);
	$verified = $sessions->verify('alice', $token, $prefix, true);
	$legacy = ['session' => $verified['session'], 'actions' => $prefix, 'revision' => 7, 'state' => $verified['savedState']];
	same(true, $mapper->insert('alice', $legacy, $clock->now));
	$upgraded = $service->get('alice');
	same([$ancestor['token']], $upgraded['session']['ancestorTokens']);
	same(0, $sessions->verify('alice', $ancestor['token'], $full)['state']['bonuses']['undo']);
	$canonical = $sessions->verify('alice', $token, $full, true);
	same(1, $canonical['savedState']['bonuses']['undo']);
	$saved = $service->save('alice', $upgraded['session']['token'], $full, 8, $token);
	same($token, $saved['session']['previousToken']);
	same([$ancestor['token']], $saved['session']['ancestorTokens']);
	same(count($full), $saved['session']['cutover']);
	sameCutoverState($canonical['savedState'], $saved['state']);
	sameGame($saved, $service->get('alice'));
};

$tests['the active-game API forwards promotion proofs and returns their current state for retries and conflicts'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = bankDependentV2History();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix, 7, 2);
	$userSession = new class implements OCP\IUserSession {
		public function getUser(): ?OCP\IUser { return new User('alice'); }
	};
	$api = new GameController(new class implements OCP\IRequest {}, $service, $userSession);
	$upgraded = $api->index()->getData()['game'];
	same(400, $api->save($upgraded['session']['token'], $full, 8, 'forged.parent')->getStatus());
	$response = $api->save($upgraded['session']['token'], $full, 8, $legacy['session']['token']);
	same(200, $response->getStatus());
	$saved = $response->getData()['game'];
	same(count($full), $saved['session']['cutover']);
	same(0, $saved['state']['bonuses']['undo']);
	$retry = $api->save($upgraded['session']['token'], $full, 8, $legacy['session']['token']);
	same(200, $retry->getStatus());
	sameGame($saved, $retry->getData()['game']);
	$native = legalHistories($sessions, 'alice', $saved)[0];
	$newest = $api->save($saved['session']['token'], $native, 9)->getData()['game'];
	$stale = $api->save($upgraded['session']['token'], $full, 8, $legacy['session']['token']);
	same(409, $stale->getStatus());
	sameGame($newest, $stale->getData()['game']);
};

$tests['a current-rules suffix prevents legacy promotion and never gets reinterpreted under old rules'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = bankDependentV2History();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix, 7, 2);
	$upgraded = $service->get('alice');
	$native = [...$prefix, ['undo']];
	$saved = $service->save('alice', $upgraded['session']['token'], $native, 8);
	same(count($prefix), $saved['session']['cutover']);
	same(1, $saved['state']['bonuses']['undo']);
	sameGame($saved, conflict(fn () => $service->save('alice', $upgraded['session']['token'], $full, 9, $legacy['session']['token']))->game);
	sameGame($saved, $service->get('alice'));
};

$tests['a current-rules save racing with legacy promotion wins its conditional update without old-rule reinterpretation'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = bankDependentV2History();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix, 7, 2);
	$upgraded = $service->get('alice');
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, $upgraded, $prefix, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$winner = $service->save('alice', $upgraded['session']['token'], [...$prefix, ['undo']], 8);
		}
	};
	$error = conflict(fn () => $service->save('alice', $upgraded['session']['token'], $full, 8, $legacy['session']['token']));
	sameGame($winner, $error->game);
	same(1, $winner['state']['bonuses']['undo']);
	sameGame($winner, $service->get('alice'));
};

$tests['identical concurrent legacy promotions share the winner token and increment the revision once'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = bankDependentV2History();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix, 7, 2);
	$upgraded = $service->get('alice');
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, $upgraded, $legacy, $full, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$winner = $service->save('alice', $upgraded['session']['token'], $full, 8, $legacy['session']['token']);
		}
	};
	$saved = $service->save('alice', $upgraded['session']['token'], $full, 8, $legacy['session']['token']);
	sameGame($winner, $saved);
	same(9, $saved['revision']);
	same(count($full), $saved['session']['cutover']);
	sameGame($saved, $service->get('alice'));
};

$tests['a different concurrent promotion wins and its history cannot be replaced by the delayed request'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = bankDependentV2History();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix, 7, 2);
	$upgraded = $service->get('alice');
	$shorter = [...$prefix, ['undo']];
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, $upgraded, $legacy, $shorter, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$winner = $service->save('alice', $upgraded['session']['token'], $shorter, 8, $legacy['session']['token']);
		}
	};
	$error = conflict(fn () => $service->save('alice', $upgraded['session']['token'], $full, 8, $legacy['session']['token']));
	sameGame($winner, $error->game);
	same(count($shorter), $winner['session']['cutover']);
	same(2, $winner['state']['bonuses']['undo']);
	sameGame($winner, $service->get('alice'));
};

$tests['adopting v1 and v2 local games returns v4 with the entire signed old history as the cutover'] = function (): void {
	foreach ([1, 2] as $version) {
		[, , $sessions, $service, $clock] = activeFixture();
		[, $actions] = $version === 1 ? legacyBankHistory() : bankDependentV2History();
		$legacy = legacySession('alice', $clock, 42, $version);
		$old = $sessions->verify('alice', $legacy['token'], $actions, true);
		$adopted = $service->save('alice', $legacy['token'], $actions, 0);
		same(5, $adopted['session']['version']);
		same($legacy['token'], $adopted['session']['previousToken']);
		same(count($actions), $adopted['session']['cutover']);
		same(0, $adopted['revision']);
		same($actions, $adopted['actions']);
		sameCutoverState($old['savedState'], $adopted['state']);
		sameGame($adopted, $service->get('alice'));
	}
};

$tests['an upgrade racing with New Game cannot overwrite the fresh token or board'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	[, $actions] = legacyBankHistory();
	insertLegacy($mapper, $sessions, $clock, $actions);
	$fresh = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, &$fresh): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$fresh = $service->ensure('alice', true);
		}
	};
	$loaded = $service->get('alice');
	sameGame($fresh, $loaded);
	same(5, $loaded['session']['version']);
	same([], $loaded['actions']);
	same(0, $loaded['revision']);
	sameGame($fresh, $service->get('alice'));
};

$tests['concurrent legacy upgrades share the winner and increment its revision only once'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	[, $actions] = legacyBankHistory();
	$legacy = insertLegacy($mapper, $sessions, $clock, $actions);
	$winner = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, &$winner): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$winner = $service->get('alice');
		}
	};
	$loaded = $service->get('alice');
	sameGame($winner, $loaded);
	same(8, $loaded['revision']);
	sameCutoverState($legacy['state'], $loaded['state']);
};

$tests['an expired legacy game is cleaned up instead of being revived by the upgrade'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	insertLegacy($mapper, $sessions, $clock, []);
	$clock->now += GameSession::MAX_AGE + 1;
	same(null, $service->get('alice'));
	same(null, $mapper->findByUser('alice'));
	$fresh = $service->ensure('alice');
	same(5, $fresh['session']['version']);
	same(false, array_key_exists('previousToken', $fresh['session']));
};

$tests['an upgrade racing with expiry cleanup cannot replace the fresh game after cleanup'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	insertLegacy($mapper, $sessions, $clock, []);
	$fresh = null;
	$db->beforeExecute = function (QueryBuilder $qb) use ($db, $service, $clock, &$fresh): void {
		if ($qb->table === 'twentyfortyeight_games' && $qb->operation === 'update') {
			$db->beforeExecute = null;
			$clock->now += GameSession::MAX_AGE + 1;
			$fresh = $service->ensure('alice', true);
		}
	};
	sameGame($service->get('alice'), $fresh);
	sameGame($fresh, $service->get('alice'));
};

$tests['application bootstrap registers the user deletion listener'] = function (): void {
	$context = new class implements OCP\AppFramework\Bootstrap\IRegistrationContext {
		public array $listeners = [];
		public array $notifiers = [];
		public function registerNotifierService(string $class): void { $this->notifiers[] = $class; }
		public function registerEventListener(string $event, string $listener, int $priority = 0): void {
			$this->listeners[] = [$event, $listener, $priority];
		}
	};
	(new Application())->register($context);
	same([\OCA\TwentyFortyEight\Notification\Notifier::class], $context->notifiers);
	same([[OCP\User\Events\UserDeletedEvent::class, UserDeletedListener::class, 0]], $context->listeners);
};

$tests['v5 upgrades native v3 history without reinterpreting old bonuses and refunds new actions'] = function (): void {
	[$db, , $sessions, , $clock] = activeFixture();
	$mapper = new ScoreMapper($db);
	$legacy = legacySession('alice', $clock, 1, 3);
	$actions = [['move', 0], ['swap', 0, 0, 0, 3]];
	$old = $sessions->verify('alice', $legacy['token'], $actions, true);
	same(null, $old['savedState']['previous']);
	same(false, $old['state']['canUndo']);
	$child = $sessions->upgrade('alice', $legacy['token'], $actions);
	same(5, $child['version']);
	same($legacy['token'], $child['previousToken']);
	$current = $sessions->verify('alice', $child['token'], $actions, true);
	sameCutoverState($old['savedState'], $current['savedState']);
	same(true, (new GameEngine(1, 4))->replay($actions)['state']['canUndo']);
	invalid(fn () => $sessions->verify('alice', $legacy['token'], [...$actions, ['undo']]));
	invalid(fn () => $sessions->verify('alice', $child['token'], [...$actions, ['undo']]));
	$tail = [...$actions, ['remove', 2]];
	$removed = $sessions->verify('alice', $child['token'], $tail, true);
	same('remove', $removed['savedState']['previous']['bonus']);
	same(1, $removed['state']['bonuses']['remove']);
	$cancelled = $sessions->verify('alice', $child['token'], [...$tail, ['undo']], true);
	same($old['state']['board'], $cancelled['state']['board']);
	same(['undo' => 1, 'swap' => 1, 'remove' => 2], $cancelled['state']['bonuses']);
	same(null, $cancelled['savedState']['previous']);
	$api = controller($mapper, 'alice', $sessions);
	same(200, $api->submit($legacy['token'], $actions)->getStatus());
	same(200, $api->submit($child['token'], [...$tail, ['undo']])->getStatus());
	same([$old['peakScore'], $old['bestTileEver'], $old['movesAtPeakScore'], $clock->now], record($mapper, 'alice'));
};

$tests['v5 preserves the full v1-v2-v3 chain and extends an offline mixed-rules tail'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	$p1 = legacySession('alice', $clock);
	$p2 = signedPayload('alice', ['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $p1['token']]);
	[$prefix] = legacyBankHistory();
	$prefix = [...$prefix, ['undo']]; // The v2 reserve keeps two ready Undo charges.
	$p3 = signedPayload('alice', ['v' => 3, 's' => 42, 'iat' => $clock->now, 'p' => $p2, 'n' => count($prefix)]);
	$actions = [...$prefix, ['remove', 2]];
	$old = $sessions->verify('alice', $p3, $actions, true);
	same(2, $old['state']['bonuses']['undo']);
	same(1, $old['state']['bonuses']['remove']);
	same(null, $old['savedState']['previous']);
	$child = $sessions->upgrade('alice', $p3, $actions);
	same([$p2, $p1['token']], $child['ancestorTokens']);
	same($p3, $child['previousToken']);
	same(true, strlen($child['token']) > 512);
	same(true, strlen($child['token']) <= GameSession::MAX_TOKEN_LENGTH);
	sameCutoverState($old['savedState'], $sessions->verify('alice', $child['token'], $actions, true)['savedState']);
	same(true, $mapper->insert('alice', ['session' => $old['session'], 'actions' => $actions,
		'revision' => 7, 'state' => $old['savedState']], $clock->now));
	$loaded = $service->get('alice');
	same($child, $loaded['session']);
	same(8, $loaded['revision']);
	sameGame($loaded, $service->get('alice'));
	$tail = null;
	foreach (range(0, 3) as $direction) {
		try { $candidate = [...$actions, ['move', $direction]]; $sessions->verify('alice', $p3, $candidate); $tail = $candidate; break; }
		catch (InvalidArgumentException) {}
	}
	if ($tail === null) throw new RuntimeException('The mixed fixture must allow an offline move');
	$saved = $service->save('alice', $child['token'], $tail, 8, $p3);
	same(count($tail), $saved['session']['cutover']);
	sameCutoverState($sessions->verify('alice', $p3, $tail, true)['savedState'], $saved['state']);
	// Once v4 has its own action, a delayed old-rules tail cannot move the cutover.
	$modern = $service->save('alice', $saved['session']['token'], [...$tail, ['undo']], 9);
	sameGame($modern, conflict(fn () => $service->save('alice', $saved['session']['token'], $tail, 10, $p3))->game);
	sameGame($modern, $service->get('alice'));
};

$tests['v4 metadata rejects forged ancestry decreasing cutovers and overlong sessions'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	$p1 = legacySession('alice', $clock, 1);
	$p3 = signedPayload('alice', ['v' => 3, 's' => 1, 'iat' => $clock->now, 'p' => $p1['token'], 'n' => 2]);
	$base = ['v' => 4, 's' => 1, 'iat' => $clock->now, 'p' => $p3, 'n' => 2];
	foreach ([1, -1, true, '2', null, GameEngine::MAX_ACTIONS + 1] as $cutover) {
		invalid(fn () => $sessions->session('alice', signedPayload('alice', [...$base, 'n' => $cutover])));
	}
	foreach ([$sessions->issue('alice')['token'], legacySession('bob', $clock, 1, 3)['token'], legacySession('alice', $clock, 2, 3)['token']] as $parent) {
		invalid(fn () => $sessions->session('alice', signedPayload('alice', [...$base, 'p' => $parent])));
	}
	invalid(fn () => $sessions->session('alice', str_repeat('a', GameSession::MAX_TOKEN_LENGTH + 1)));
	$native = legacySession('alice', $clock, 1, 3);
	$child = $sessions->upgrade('alice', $native['token'], [['move', 0]]);
	invalid(fn () => $sessions->verify('alice', $child['token'], []));
	invalid(fn () => $sessions->verify('alice', $child['token'], array_fill(0, GameEngine::MAX_ACTIONS + 1, ['move', 0])));
	$sessions->revoke('alice');
	invalid(fn () => $sessions->verify('alice', $native['token'], [['move', 0]]));
	invalid(fn () => $sessions->verify('alice', $child['token'], [['move', 0]]));
};

$tests['v4 token migration only widens the column and is idempotent'] = function (): void {
	[$db, , $schema] = fixture();
	$table = $schema->getTable('twentyfortyeight_games');
	$table->getColumn('session_token')->setLength(512);
	$before = $table->columns;
	$output = new class implements OCP\Migration\IOutput {};
	$migration = new Version000600Date20261012000000();
	same($schema, $migration->changeSchema($output, fn () => $schema, []));
	same(1024, $table->getColumn('session_token')->getLength());
	$before['session_token'][1]['length'] = 1024;
	same($before, $table->columns);
	same(null, $migration->changeSchema($output, fn () => $schema, []));
	same(null, $migration->changeSchema($output, fn () => new Schema(), []));
};

foreach ([1, 2] as $sourceVersion) {
	$tests['v5 extends the inner v3 cutover for an offline v' . $sourceVersion . ' ancestor'] = function () use ($sourceVersion): void {
		[, $mapper, $sessions, $service, $clock] = activeFixture();
		$p1 = legacySession('alice', $clock);
		$p2 = signedPayload('alice', ['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $p1['token']]);
		[$prefix, $full] = $sourceVersion === 1 ? legacyBankHistory() : bankDependentV2History();
		$p3 = signedPayload('alice', ['v' => 3, 's' => 42, 'iat' => $clock->now, 'p' => $p2, 'n' => count($prefix)]);
		$old = $sessions->verify('alice', $p3, $prefix, true);
		$source = $sourceVersion === 1 ? $p1['token'] : $p2;
		$sessions->verify('alice', $source, $full);
		if ($sourceVersion === 2) invalid(fn () => $sessions->verify('alice', $p3, $full));
		same(true, $mapper->insert('alice', ['session' => $old['session'], 'actions' => $prefix,
			'revision' => 7, 'state' => $old['savedState']], $clock->now));
		$target = $service->get('alice');
		same(count($prefix), $target['session']['previousCutover']);
		$saved = $service->save('alice', $target['session']['token'], $full, 8, $p3, $source);
		same(count($full), $saved['session']['cutover']);
		same(count($full), $saved['session']['previousCutover']);
		sameCutoverState($sessions->verify('alice', $p2, $full, true)['savedState'], $saved['state']);
		same(false, $saved['session']['previousToken'] === $p3);
		same([$p2, $p1['token']], $saved['session']['ancestorTokens']);
		sameGame($saved, $service->get('alice'));
		sameGame($saved, $service->save('alice', $target['session']['token'], $full, 8, $p3, $source));
	};
}

$tests['v5 refuses ancestor promotion after its v3 parent has played a suffix'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	$p2 = legacySession('alice', $clock, 42, 2);
	[$prefix, $full] = bankDependentV2History();
	$p3 = signedPayload('alice', ['v' => 3, 's' => 42, 'iat' => $clock->now, 'p' => $p2['token'], 'n' => count($prefix)]);
	$played = [...$prefix, ['undo']];
	$old = $sessions->verify('alice', $p3, $played, true);
	same(true, $mapper->insert('alice', ['session' => $old['session'], 'actions' => $played,
		'revision' => 7, 'state' => $old['savedState']], $clock->now));
	$target = $service->get('alice');
	same(true, $target['session']['previousCutover'] < $target['session']['cutover']);
	sameGame($target, conflict(fn () => $service->save('alice', $target['session']['token'], $full, 8, $p3, $p2['token']))->game);
	sameGame($target, $service->get('alice'));
};

$tests['v5 ancestor promotion rejects unknown or foreign source sessions'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	$p2 = legacySession('alice', $clock, 42, 2);
	[$prefix, $full] = bankDependentV2History();
	$p3 = signedPayload('alice', ['v' => 3, 's' => 42, 'iat' => $clock->now, 'p' => $p2['token'], 'n' => count($prefix)]);
	$old = $sessions->verify('alice', $p3, $prefix, true);
	same(true, $mapper->insert('alice', ['session' => $old['session'], 'actions' => $prefix,
		'revision' => 7, 'state' => $old['savedState']], $clock->now));
	$target = $service->get('alice');
	foreach (['forged.source', $target['session']['token'], legacySession('bob', $clock, 42, 2)['token']] as $source) {
		invalid(fn () => $service->save('alice', $target['session']['token'], $full, 8, $p3, $source));
		invalid(fn () => $sessions->extendUpgrade('alice', $target['session']['token'], $p3, $full, $source));
	}
	sameGame($target, $service->get('alice'));
};

require __DIR__ . '/leaderboard_cases.php';

$failed = 0;
foreach ($tests as $name => $test) {
	try {
		$test();
		echo 'PASS ' . $name . "\n";
	} catch (Throwable $e) {
		$failed++;
		fwrite(STDERR, 'FAIL ' . $name . ': ' . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
	}
}
echo count($tests) . ' backend tests, ' . $failed . " failures.\n";
exit($failed === 0 ? 0 : 1);

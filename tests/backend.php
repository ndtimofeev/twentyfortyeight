<?php

declare(strict_types=1);

// Run with: php tests/backend.php (requires pdo_sqlite).
require __DIR__ . '/fixtures/nextcloud.php';
foreach ([
	'Db/Score', 'Db/ScoreMapper', 'Db/ActiveGameMapper', 'AppInfo/Application',
	'Game/GameEngine', 'Game/GameSession',
	'Game/ActiveGameConflict', 'Game/ActiveGameService',
	'Controller/ScoreController', 'Controller/GameController', 'Listener/UserDeletedListener',
	'Migration/Version000100Date20261010000000', 'Migration/Version000200Date20261012000000',
	'Migration/Version000300Date20261012000000',
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
use OCA\TwentyFortyEight\Game\GameSession;
use OCA\TwentyFortyEight\Listener\UserDeletedListener;
use OCA\TwentyFortyEight\Migration\Version000100Date20261010000000;
use OCA\TwentyFortyEight\Migration\Version000200Date20261012000000;
use OCA\TwentyFortyEight\Migration\Version000300Date20261012000000;
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
	$schema->apply($db);
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
	return new ScoreController(new class implements OCP\IRequest {}, $mapper, $session, $users, $clock, $games);
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

function legacySession(string $uid, Clock $clock, int $seed = 42): array {
	return ['token' => signedPayload($uid, ['v' => 1, 's' => $seed, 'iat' => $clock->now]), 'seed' => $seed, 'version' => 1];
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

function insertLegacy(ActiveGameMapper $mapper, GameSession $sessions, Clock $clock, array $actions, int $revision = 7): array {
	$session = legacySession('alice', $clock);
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

$tests['new tokens use banked rules while legacy proofs retain their original counter and score behavior'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	same(2, $sessions->issue('alice')['version']);
	$legacy = legacySession('alice', $clock);
	[$prefix, $actions] = legacyBankHistory();
	$old = $sessions->verify('alice', $legacy['token'], $actions, true);
	same(1, $old['session']['version']);
	same(0, $old['savedState']['bonuses']['undo']);
	same(false, array_key_exists('pendingBonuses', $old['savedState']));
	$new = $sessions->upgrade('alice', $legacy['token'], $actions);
	same(2, $new['version']);
	same(42, $new['seed']);
	same($legacy['token'], $new['previousToken']);
	$banked = $sessions->verify('alice', $new['token'], $actions, true);
	same(1, $banked['savedState']['bonuses']['undo']);
	same(0, $banked['savedState']['pendingBonuses']['undo']);
	same($old['peakScore'], $banked['peakScore']);
	same($old['bestTileEver'], $banked['bestTileEver']);
	same($old['movesAtPeakScore'], $banked['movesAtPeakScore']);
	same(json_encode($old), json_encode($sessions->verify('alice', $legacy['token'], $actions, true)));
	$first128 = $sessions->verify('alice', $new['token'], $prefix, true);
	same(2, $first128['savedState']['bonuses']['undo']);
	same(1, $first128['savedState']['pendingBonuses']['undo']);
};

$tests['upgraded tokens validate their signed parent UID seed version and shape'] = function (): void {
	[, , $sessions, , $clock] = activeFixture();
	$parent = legacySession('alice', $clock);
	$upgraded = $sessions->upgrade('alice', $parent['token'], []);
	$verified = $sessions->verify('alice', $upgraded['token'], [], true);
	same($parent['token'], $verified['session']['previousToken']);
	same(true, strlen($upgraded['token']) <= 512);
	$foreign = legacySession('bob', $clock);
	$otherSeed = legacySession('alice', $clock, 1);
	$cases = [
		['v' => 3, 's' => 42, 'iat' => $clock->now],
		['v' => 1, 's' => 42, 'iat' => $clock->now, 'p' => $parent['token']],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => null],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => 'forged.parent'],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $foreign['token']],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $otherSeed['token']],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'p' => $upgraded['token']],
		['v' => 2, 's' => 42, 'iat' => $clock->now, 'extra' => true],
	];
	foreach ($cases as $payload) {
		try {
			$sessions->verify('alice', signedPayload('alice', $payload), []);
			throw new RuntimeException('Malformed signed parent metadata accepted');
		} catch (InvalidArgumentException) {
		}
	}
	$clock->now += GameSession::MAX_AGE;
	$renewed = $sessions->upgrade('alice', $parent['token'], []);
	$clock->now++;
	// The child has its own age; the authentic parent can now be expired.
	$sessions->verify('alice', $renewed['token'], []);
	try {
		$sessions->upgrade('alice', $parent['token'], []);
		throw new RuntimeException('Expired legacy session was upgraded');
	} catch (InvalidArgumentException) {
	}
	$sessions->revoke('alice');
	try {
		$sessions->verify('alice', $renewed['token'], []);
		throw new RuntimeException('Deletion did not revoke the child token');
	} catch (InvalidArgumentException) {
	}
};

$tests['loading a legacy active game upgrades it once and recovers the lost reward without changing its board'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[, $actions] = legacyBankHistory();
	$legacy = insertLegacy($mapper, $sessions, $clock, $actions);
	same(0, $legacy['state']['bonuses']['undo']);
	$upgraded = $service->get('alice');
	same(2, $upgraded['session']['version']);
	same($legacy['session']['token'], $upgraded['session']['previousToken']);
	same(8, $upgraded['revision']);
	same($actions, $upgraded['actions']);
	same(1, $upgraded['state']['bonuses']['undo']);
	foreach (['grid', 'score', 'moves', 'over', 'won', 'keepPlaying', 'maxTile', 'peakScore', 'previous', 'randomState', 'reached'] as $field) {
		same(json_encode($legacy['state'][$field]), json_encode($upgraded['state'][$field]));
	}
	sameGame($upgraded, $service->get('alice'));
	sameGame($upgraded, $service->ensure('alice'));
	sameGame($upgraded, conflict(fn () => $service->save('alice', $legacy['session']['token'], $actions, 7))->game);
	same($upgraded['session']['token'], $mapper->findByUser('alice')['session_token']);
};

$tests['an upgraded token accepts a compatible unsent legacy tail while retaining its recovered reward'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix, $full] = legacyBankHistory();
	$legacy = insertLegacy($mapper, $sessions, $clock, $prefix);
	$upgraded = $service->get('alice');
	same(1, $upgraded['state']['pendingBonuses']['undo']);
	$saved = $service->save('alice', $upgraded['session']['token'], $full, $upgraded['revision']);
	same(9, $saved['revision']);
	same($full, $saved['actions']);
	same(1, $saved['state']['bonuses']['undo']);
	same(0, $saved['state']['pendingBonuses']['undo']);
	$old = $sessions->verify('alice', $legacy['session']['token'], $full, true);
	same(0, $old['savedState']['bonuses']['undo']);
	same(json_encode($old['savedState']['grid']), json_encode($saved['state']['grid']));
	same($old['savedState']['randomState'], $saved['state']['randomState']);
};

$tests['adopting an older local game immediately returns banked rules with signed parent metadata'] = function (): void {
	[, , $sessions, $service, $clock] = activeFixture();
	[, $actions] = legacyBankHistory();
	$legacy = legacySession('alice', $clock);
	$adopted = $service->save('alice', $legacy['token'], $actions, 0);
	same(2, $adopted['session']['version']);
	same($legacy['token'], $adopted['session']['previousToken']);
	same(0, $adopted['revision']);
	same($actions, $adopted['actions']);
	same(1, $adopted['state']['bonuses']['undo']);
	sameGame($adopted, $service->get('alice'));
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
	same(2, $loaded['session']['version']);
	same([], $loaded['actions']);
	same(0, $loaded['revision']);
	sameGame($fresh, $service->get('alice'));
};

$tests['concurrent legacy upgrades share the winner and increment its revision only once'] = function (): void {
	[$db, $mapper, $sessions, $service, $clock] = activeFixture();
	[, $actions] = legacyBankHistory();
	insertLegacy($mapper, $sessions, $clock, $actions);
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
	same(1, $loaded['state']['bonuses']['undo']);
};

$tests['an expired legacy game is cleaned up instead of being revived by the upgrade'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	insertLegacy($mapper, $sessions, $clock, []);
	$clock->now += GameSession::MAX_AGE + 1;
	same(null, $service->get('alice'));
	same(null, $mapper->findByUser('alice'));
	$fresh = $service->ensure('alice');
	same(2, $fresh['session']['version']);
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
		public function registerEventListener(string $event, string $listener, int $priority = 0): void {
			$this->listeners[] = [$event, $listener, $priority];
		}
	};
	(new Application())->register($context);
	same([[OCP\User\Events\UserDeletedEvent::class, UserDeletedListener::class, 0]], $context->listeners);
};

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

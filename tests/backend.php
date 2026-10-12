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

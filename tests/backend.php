<?php

declare(strict_types=1);

// Run with: php tests/backend.php (requires pdo_sqlite).
require __DIR__ . '/fixtures/nextcloud.php';
foreach ([
	'Db/Score', 'Db/ScoreMapper', 'AppInfo/Application',
	'Game/GameEngine', 'Game/GameSession',
	'Controller/ScoreController', 'Listener/UserDeletedListener',
	'Migration/Version000100Date20261010000000', 'Migration/Version000200Date20261012000000',
] as $class) {
	require __DIR__ . '/../lib/' . $class . '.php';
}

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Controller\ScoreController;
use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCA\TwentyFortyEight\Game\GameSession;
use OCA\TwentyFortyEight\Listener\UserDeletedListener;
use OCA\TwentyFortyEight\Migration\Version000100Date20261010000000;
use OCA\TwentyFortyEight\Migration\Version000200Date20261012000000;
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
	$listener = new UserDeletedListener($mapper, $games);
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

<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Service;

use DateTime;
use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCP\Notification\IManager;
use Psr\Log\LoggerInterface;

/** Record updates and their notifications share the same database transaction. */
class LeaderboardService {
	public function __construct(private ScoreMapper $mapper, private IManager $notifications, private LoggerInterface $logger) {
	}

	public function store(string $uid, int $score, int $tile, int $moves, int $now): void {
		$flush = $this->notifications->defer();
		$this->mapper->withLeaderboardLock(function () use ($uid, $score, $tile, $moves, $now): void {
			$leaders = $this->mapper->findLeaders();
			$this->mapper->storeBest($uid, $score, $tile, $moves, $now);
			if ($leaders === [] || $score <= $leaders[0]->getScore()) return;
			foreach ($leaders as $leader) {
				if ($leader->getUserId() === $uid) continue;
				$notification = $this->notifications->createNotification();
				$notification->setApp(Application::APP_ID)
					->setUser($leader->getUserId())
					->setDateTime((new DateTime())->setTimestamp($now))
					->setObject('leaderboard', $uid)
					->setSubject('leader_lost', ['user' => $uid, 'score' => $score]);
				$this->notifications->notify($notification);
			}
		});
		// Publish push payloads only after the record and notification rows commit.
		if ($flush) {
			try { $this->notifications->flush(); }
			catch (\Throwable $e) { $this->logger->warning('2048 notification push failed; the notification remains stored.', ['exception' => $e]); }
		}
	}
}

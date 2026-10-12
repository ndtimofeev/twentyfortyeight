<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Controller;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCA\TwentyFortyEight\Game\GameSession;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;
use OCP\IUserManager;
use OCP\IUserSession;

class ScoreController extends Controller {
	private const LEADERBOARD_SIZE = 20;

	public function __construct(
		IRequest $request,
		private ScoreMapper $mapper,
		private IUserSession $userSession,
		private IUserManager $userManager,
		private ITimeFactory $time,
		private GameSession $games,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return new DataResponse($this->leaderboardData($this->currentUid()));
	}

	/**
	 * Verify the game's actions and store the records calculated by the server.
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 60, period: 60)]
	public function submit(string $session, array $actions): DataResponse {
		$uid = $this->currentUid();
		try {
			$stats = $this->games->verify($uid, $session, $actions);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}

		$this->storeScore($uid, $stats['peakScore'], $stats['bestTileEver'], $stats['movesAtPeakScore']);

		return new DataResponse($this->leaderboardData($uid));
	}

	private function currentUid(): string {
		// The routes are not public, so a user is always present.
		return $this->userSession->getUser()->getUID();
	}

	private function storeScore(string $uid, int $score, int $bestTile, int $moves): void {
		$this->mapper->storeBest($uid, $score, $bestTile, $moves, $this->time->getTime());
	}

	private function leaderboardData(string $uid): array {
		$entries = [];
		$rank = 0;
		$previousScore = null;
		foreach ($this->mapper->findTop(self::LEADERBOARD_SIZE) as $i => $entry) {
			if ($entry->getScore() !== $previousScore) {
				$rank = $i + 1;
				$previousScore = $entry->getScore();
			}
			$entries[] = [
				'rank' => $rank,
				'userId' => $entry->getUserId(),
				'displayName' => $this->displayName($entry->getUserId()),
				'score' => $entry->getScore(),
				'bestTile' => $entry->getBestTile(),
				'isMe' => $entry->getUserId() === $uid,
			];
		}

		$mine = $this->mapper->findByUser($uid);

		return [
			'leaderboard' => $entries,
			'me' => $mine === null ? null : [
				'rank' => $this->mapper->rankOf($mine),
				'score' => $mine->getScore(),
				'bestTile' => $mine->getBestTile(),
			],
		];
	}

	private function displayName(string $uid): string {
		return $this->userManager->get($uid)?->getDisplayName() ?? $uid;
	}
}

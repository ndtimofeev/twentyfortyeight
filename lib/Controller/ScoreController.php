<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Controller;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Db\Score;
use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\Exception as DbException;
use OCP\IRequest;
use OCP\IUserManager;
use OCP\IUserSession;

class ScoreController extends Controller {
	private const LEADERBOARD_SIZE = 20;
	/** Theoretical maximum score on a 4x4 board is a bit below 4 million. */
	private const MAX_SCORE = 4_000_000;
	private const MAX_MOVES = 1_000_000;

	public function __construct(
		IRequest $request,
		private ScoreMapper $mapper,
		private IUserSession $userSession,
		private IUserManager $userManager,
		private ITimeFactory $time,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return new DataResponse($this->buildResponse($this->currentUid()));
	}

	/**
	 * Stores the score if it beats the user's previous best.
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 60, period: 60)]
	public function submit(int $score, int $bestTile, int $moves): DataResponse {
		if ($score < 0 || $score > self::MAX_SCORE
			|| $moves < 0 || $moves > self::MAX_MOVES
			|| !$this->isValidTile($bestTile)) {
			return new DataResponse(['message' => 'Invalid score'], Http::STATUS_BAD_REQUEST);
		}

		$uid = $this->currentUid();
		$this->save($uid, $score, $bestTile, $moves);

		return new DataResponse($this->buildResponse($uid));
	}

	private function isValidTile(int $tile): bool {
		// 0 (nothing yet) or a power of two between 2 and 2^17
		return $tile === 0 || ($tile >= 2 && $tile <= 131072 && ($tile & ($tile - 1)) === 0);
	}

	private function currentUid(): string {
		// The routes are not public, so a user is always present.
		return $this->userSession->getUser()->getUID();
	}

	private function save(string $uid, int $score, int $bestTile, int $moves, bool $retry = true): void {
		$existing = $this->mapper->findByUser($uid);

		if ($existing === null) {
			$entry = new Score();
			$entry->setUserId($uid);
			$entry->setScore($score);
			$entry->setBestTile($bestTile);
			$entry->setMoves($moves);
			$entry->setUpdatedAt($this->time->getTime());
			try {
				$this->mapper->insert($entry);
			} catch (DbException $e) {
				// Two tabs submitting the first score at the same time.
				if ($retry && $e->getReason() === DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
					$this->save($uid, $score, $bestTile, $moves, false);
					return;
				}
				throw $e;
			}
			return;
		}

		if ($score > $existing->getScore()) {
			$existing->setScore($score);
			$existing->setBestTile(max($bestTile, $existing->getBestTile()));
			$existing->setMoves($moves);
			$existing->setUpdatedAt($this->time->getTime());
			$this->mapper->update($existing);
		} elseif ($bestTile > $existing->getBestTile()) {
			$existing->setBestTile($bestTile);
			$this->mapper->update($existing);
		}
	}

	private function buildResponse(string $uid): array {
		$entries = [];
		foreach ($this->mapper->findTop(self::LEADERBOARD_SIZE) as $i => $entry) {
			$entries[] = [
				'rank' => $i + 1,
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

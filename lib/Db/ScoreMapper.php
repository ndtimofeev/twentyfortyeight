<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\Exception as DbException;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @template-extends QBMapper<Score>
 */
class ScoreMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'twentyfortyeight_records', Score::class);
	}

	public function findByUser(string $userId): ?Score {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));

		try {
			return $this->findEntity($qb);
		} catch (DoesNotExistException) {
			return null;
		}
	}

	/** Serialize leaderboard transitions across users on every supported database. */
	public function withLeaderboardLock(callable $action): void {
		$this->db->beginTransaction();
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->update('twentyfortyeight_lock')
				->set('id', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT))
				->where($qb->expr()->eq('id', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT)))
				->executeStatement();
			$action();
			$this->db->commit();
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	/** @return Score[] All users sharing first place, including ties beyond the top 20. */
	public function findLeaders(): array {
		$top = $this->findTop(1);
		if ($top === []) return [];
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('score', $qb->createNamedParameter($top[0]->getScore(), IQueryBuilder::PARAM_INT)));
		return $this->findEntities($qb);
	}

	/**
	 * Keep personal records monotonic even when several sessions submit at once.
	 * No value read from the database is later written back: each maximum is
	 * advanced by its own conditional UPDATE, on every supported database.
	 */
	public function storeBest(string $userId, int $score, int $bestTile, int $moves, int $updatedAt): void {
		if ($this->advanceBest($userId, $score, $bestTile, $moves, $updatedAt)
			|| $this->findByUser($userId) !== null) {
			return;
		}

		$entry = new Score();
		$entry->setUserId($userId);
		$entry->setScore($score);
		$entry->setBestTile($bestTile);
		$entry->setMoves($moves);
		$entry->setUpdatedAt($updatedAt);
		try {
			$this->insert($entry);
		} catch (DbException $e) {
			if ($e->getReason() !== DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
				throw $e;
			}
			// Another session created the row after our existence check.
			$this->advanceBest($userId, $score, $bestTile, $moves, $updatedAt);
		}
	}

	private function advanceBest(string $userId, int $score, int $bestTile, int $moves, int $updatedAt): bool {
		$qb = $this->db->getQueryBuilder();
		$scoreParameter = $qb->createNamedParameter($score, IQueryBuilder::PARAM_INT);
		$qb->update($this->getTableName())
			->set('score', $scoreParameter)
			->set('moves', $qb->createNamedParameter($moves, IQueryBuilder::PARAM_INT))
			->set('updated_at', $qb->createNamedParameter($updatedAt, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->lt('score', $qb->createNamedParameter($score, IQueryBuilder::PARAM_INT)));
		$scoreChanged = $qb->executeStatement() > 0;

		// A different game can set the tile record without setting a score record.
		$qb = $this->db->getQueryBuilder();
		$tileParameter = $qb->createNamedParameter($bestTile, IQueryBuilder::PARAM_INT);
		$qb->update($this->getTableName())
			->set('best_tile', $tileParameter)
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->lt('best_tile', $qb->createNamedParameter($bestTile, IQueryBuilder::PARAM_INT)));
		$tileChanged = $qb->executeStatement() > 0;

		return $scoreChanged || $tileChanged;
	}

	public function deleteByUser(string $userId): void {
		// Keep the original, unverified scores as an archive on upgrade, but
		// remove that user's personal data from both generations on deletion.
		foreach ([$this->getTableName(), 'twentyfortyeight_scores'] as $table) {
			$qb = $this->db->getQueryBuilder();
			$qb->delete($table)
				->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
			$qb->executeStatement();
		}
	}

	/**
	 * @return Score[]
	 */
	public function findTop(int $limit): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->orderBy('score', 'DESC')
			->addOrderBy('updated_at', 'ASC')
			->addOrderBy('user_id', 'ASC')
			->addOrderBy('id', 'ASC')
			->setMaxResults($limit);

		return $this->findEntities($qb);
	}

	/**
	 * Competition ranking: equal scores share a place (1, 1, 3).
	 */
	public function rankOf(Score $score): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->count('*', 'cnt'))
			->from($this->getTableName())
			->where($qb->expr()->gt('score', $qb->createNamedParameter($score->getScore(), IQueryBuilder::PARAM_INT)));
		$result = $qb->executeQuery();
		$higher = (int)$result->fetchOne();
		$result->closeCursor();

		return $higher + 1;
	}
}

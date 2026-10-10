<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @template-extends QBMapper<Score>
 */
class ScoreMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'twentyfortyeight_scores', Score::class);
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

	/**
	 * @return Score[]
	 */
	public function findTop(int $limit): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->orderBy('score', 'DESC')
			->addOrderBy('updated_at', 'ASC')
			->setMaxResults($limit);

		return $this->findEntities($qb);
	}

	/**
	 * 1-based place of the given score in the leaderboard.
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

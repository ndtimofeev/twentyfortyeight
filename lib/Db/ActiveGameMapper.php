<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Db;

use OCP\DB\Exception as DbException;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/** One active game per user, with conditional writes for tabs and devices. */
class ActiveGameMapper {
	private const TABLE = 'twentyfortyeight_games';

	public function __construct(private IDBConnection $db) {
	}

	public function findByUser(string $uid): ?array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from(self::TABLE)
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($uid)));
		$result = $qb->executeQuery();
		$row = $result->fetch();
		$result->closeCursor();
		if ($row === false) {
			return null;
		}
		$row['revision'] = (int)$row['revision'];
		return $row;
	}

	/** A competing initial save is a conflict, never an overwrite. */
	public function insert(string $uid, array $game, int $now): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->insert(self::TABLE)->setValue('user_id', $qb->createNamedParameter($uid));
		foreach ($this->values($game, $now) as $key => [$value, $type]) {
			$qb->setValue($key, $qb->createNamedParameter($value, $type));
		}
		try {
			$qb->executeStatement();
			return true;
		} catch (DbException $e) {
			if ($e->getReason() !== DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
				throw $e;
			}
			return false;
		}
	}

	public function replace(string $uid, string $oldToken, int $oldRevision, array $game, int $now): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::TABLE);
		foreach ($this->values($game, $now) as $key => [$value, $type]) {
			$qb->set($key, $qb->createNamedParameter($value, $type));
		}
		$this->whereCurrent($qb, $uid, $oldToken, $oldRevision);
		return $qb->executeStatement() > 0;
	}

	/** Expiry cleanup must not remove a game replaced while we were checking it. */
	public function deleteIfCurrent(string $uid, string $token, int $revision): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE);
		$this->whereCurrent($qb, $uid, $token, $revision);
		return $qb->executeStatement() > 0;
	}

	public function deleteByUser(string $uid): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)->where($qb->expr()->eq('user_id', $qb->createNamedParameter($uid)));
		$qb->executeStatement();
	}

	private function whereCurrent(IQueryBuilder $qb, string $uid, string $token, int $revision): void {
		$qb->where($qb->expr()->eq('user_id', $qb->createNamedParameter($uid)))
			->andWhere($qb->expr()->eq('session_hash', $qb->createNamedParameter(hash('sha256', $token))))
			->andWhere($qb->expr()->eq('revision', $qb->createNamedParameter($revision, IQueryBuilder::PARAM_INT)));
	}

	private function values(array $game, int $now): array {
		return [
			'session_token' => [$game['session']['token'], IQueryBuilder::PARAM_STR],
			'session_hash' => [hash('sha256', $game['session']['token']), IQueryBuilder::PARAM_STR],
			'actions' => [json_encode($game['actions'], JSON_THROW_ON_ERROR), IQueryBuilder::PARAM_STR],
			'state' => [json_encode($game['state'], JSON_THROW_ON_ERROR), IQueryBuilder::PARAM_STR],
			'revision' => [$game['revision'], IQueryBuilder::PARAM_INT],
			'updated_at' => [$now, IQueryBuilder::PARAM_INT],
		];
	}
}

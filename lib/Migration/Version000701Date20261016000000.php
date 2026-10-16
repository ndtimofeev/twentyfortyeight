<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Migration;

use Closure;
use OCP\DB\Exception as DbException;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/** Use a short lock name on NC31/32, including upgrades from the first 0.7.0. */
class Version000701Date20261016000000 extends SimpleMigrationStep {
	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		$changed = false;
		if (!$schema->hasTable('twentyfortyeight_lock')) {
			$table = $schema->createTable('twentyfortyeight_lock');
			$table->addColumn('id', Types::INTEGER, ['autoincrement' => true, 'notnull' => true]);
			$table->setPrimaryKey(['id']);
			$changed = true;
		}
		if ($schema->hasTable('twentyfortyeight_leader_lock')) {
			// The old table contains only a mutex row, no game or user data.
			$schema->dropTable('twentyfortyeight_leader_lock');
			$changed = true;
		}
		return $changed ? $schema : null;
	}

	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		$qb = $this->db->getQueryBuilder();
		$result = $qb->select('id')->from('twentyfortyeight_lock')
			->where($qb->expr()->eq('id', $qb->createNamedParameter(1)))->executeQuery();
		$exists = $result->fetchOne() !== false;
		$result->closeCursor();
		if ($exists) return;
		$qb = $this->db->getQueryBuilder();
		try {
			$qb->insert('twentyfortyeight_lock')->setValue('id', $qb->createNamedParameter(1))->executeStatement();
		} catch (DbException $e) {
			if ($e->getReason() !== DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) throw $e;
		}
	}
}

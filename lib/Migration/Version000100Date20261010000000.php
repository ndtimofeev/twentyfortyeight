<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version000100Date20261010000000 extends SimpleMigrationStep {
	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('twentyfortyeight_scores')) {
			return null;
		}

		$table = $schema->createTable('twentyfortyeight_scores');
		$table->addColumn('id', Types::BIGINT, [
			'autoincrement' => true,
			'notnull' => true,
		]);
		$table->addColumn('user_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('score', Types::INTEGER, [
			'notnull' => true,
			'default' => 0,
		]);
		$table->addColumn('best_tile', Types::INTEGER, [
			'notnull' => true,
			'default' => 0,
		]);
		$table->addColumn('moves', Types::INTEGER, [
			'notnull' => true,
			'default' => 0,
		]);
		$table->addColumn('updated_at', Types::BIGINT, [
			'notnull' => true,
			'default' => 0,
		]);
		$table->setPrimaryKey(['id'], 'tfe_scores_pk');
		$table->addUniqueIndex(['user_id'], 'tfe_user_idx');
		$table->addIndex(['score'], 'tfe_score_idx');

		return $schema;
	}
}

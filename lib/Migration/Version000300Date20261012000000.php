<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/** Persist each user's verified active game across browsers and devices. */
class Version000300Date20261012000000 extends SimpleMigrationStep {
	/** @param Closure(): ISchemaWrapper $schemaClosure */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('twentyfortyeight_games')) {
			return null;
		}
		$table = $schema->createTable('twentyfortyeight_games');
		$table->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
		$table->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
		$table->addColumn('session_token', Types::STRING, ['notnull' => true, 'length' => 512]);
		$table->addColumn('session_hash', Types::STRING, ['notnull' => true, 'length' => 64]);
		$table->addColumn('actions', Types::TEXT, ['notnull' => true]);
		$table->addColumn('state', Types::TEXT, ['notnull' => true]);
		$table->addColumn('revision', Types::BIGINT, ['notnull' => true, 'default' => 0]);
		$table->addColumn('updated_at', Types::BIGINT, ['notnull' => true, 'default' => 0]);
		$table->setPrimaryKey(['id'], 'tfe_games_pk');
		$table->addUniqueIndex(['user_id'], 'tfe_games_user_idx');
		return $schema;
	}
}

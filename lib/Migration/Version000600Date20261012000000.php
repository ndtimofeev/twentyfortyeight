<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/** Allow the signed v1/v2/v3/v4 chain without replacing any saved history. */
class Version000600Date20261012000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('twentyfortyeight_games')) return null;
		$column = $schema->getTable('twentyfortyeight_games')->getColumn('session_token');
		if ($column->getLength() >= 1024) return null;
		$column->setLength(1024);
		return $schema;
	}
}

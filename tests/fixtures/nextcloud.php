<?php

declare(strict_types=1);

// Minimal framework adapters for running the application's real PHP classes
// against SQLite without installing Nextcloud. Nextcloud integration runs
// separately; these adapters deliberately implement no game or record rules.
namespace OCP {
	interface IRequest {}
	interface IUser { public function getUID(): string; public function getDisplayName(): string; }
	interface IUserSession { public function getUser(): ?IUser; }
	interface IUserManager { public function get(string $uid): ?IUser; }
	interface IDBConnection { public function getQueryBuilder(): \OCP\DB\QueryBuilder\IQueryBuilder; }
	interface IConfig {}
}

namespace OCP\DB {
	class Exception extends \Exception {
		public const REASON_UNIQUE_CONSTRAINT_VIOLATION = 14;
		public function getReason(): ?int { return null; }
	}
	class Types {
		public const BIGINT = 'bigint';
		public const INTEGER = 'integer';
		public const STRING = 'string';
	}
	interface ISchemaWrapper {
		public function hasTable(string $name): bool;
		public function createTable(string $name): \TwentyFortyEightTests\Table;
	}
}

namespace OCP\DB\QueryBuilder {
	interface IQueryBuilder { public const PARAM_INT = 1; public const PARAM_STR = 2; }
}

namespace OCP\AppFramework {
	class App { public function __construct(string $id) {} }
	class Controller { public function __construct(string $id, \OCP\IRequest $request) {} }
	class Http { public const STATUS_BAD_REQUEST = 400; }
}

namespace OCP\AppFramework\Bootstrap {
	interface IBootContext {}
	interface IRegistrationContext {
		public function registerEventListener(string $event, string $listener, int $priority = 0): void;
	}
	interface IBootstrap {
		public function register(IRegistrationContext $context): void;
		public function boot(IBootContext $context): void;
	}
}

namespace OCP\AppFramework\Http {
	class DataResponse {
		public function __construct(private $data, private int $status = 200) {}
		public function getData() { return $this->data; }
		public function getStatus(): int { return $this->status; }
	}
}

namespace OCP\AppFramework\Utility {
	interface ITimeFactory { public function getTime(): int; }
}

namespace OCP\EventDispatcher {
	class Event {}
	interface IEventListener { public function handle(Event $event): void; }
}

namespace OCP\User\Events {
	class UserDeletedEvent extends \OCP\EventDispatcher\Event {
		public function __construct(private \OCP\IUser $user) {}
		public function getUser(): \OCP\IUser { return $this->user; }
	}
}

namespace OCP\Migration {
	interface IOutput {}
	class SimpleMigrationStep {}
}

namespace OCP\AppFramework\Db {
	class DoesNotExistException extends \Exception {}
	class Entity {
		protected $id;
		private array $types = [];
		private array $updated = [];
		public function addType(string $property, string $type): void { $this->types[$property] = $type; }
		public function getFieldTypes(): array { return $this->types; }
		public function getUpdatedFields(): array { return $this->updated; }
		public function propertyToColumn(string $property): string {
			return preg_replace_callback('/[A-Z]/', fn ($m) => '_' . strtolower($m[0]), $property);
		}
		public function __call(string $name, array $arguments) {
			$property = lcfirst(substr($name, 3));
			if (str_starts_with($name, 'get')) { return $this->$property; }
			if (!str_starts_with($name, 'set')) { throw new \LogicException($name); }
			$this->$property = $arguments[0];
			$this->updated[$property] = true;
		}
		public static function fromRow(array $row): static {
			$entity = new static();
			foreach ($row as $column => $value) {
				$property = preg_replace_callback('/_([a-z])/', fn ($m) => strtoupper($m[1]), $column);
				$entity->$property = ($entity->types[$property] ?? '') === 'integer' ? (int)$value : $value;
			}
			return $entity;
		}
	}
	class QBMapper {
		public function __construct(protected \OCP\IDBConnection $db, private string $table, private string $entityClass) {}
		public function getTableName(): string { return $this->table; }
		protected function findEntities(\OCP\DB\QueryBuilder\IQueryBuilder $qb): array {
			$result = $qb->executeQuery();
			$entities = [];
			while ($row = $result->fetch()) { $entities[] = ($this->entityClass)::fromRow($row); }
			$result->closeCursor();
			return $entities;
		}
		protected function findEntity(\OCP\DB\QueryBuilder\IQueryBuilder $qb): Entity {
			$entities = $this->findEntities($qb);
			if ($entities === []) { throw new DoesNotExistException(); }
			if (count($entities) !== 1) { throw new \LogicException('Duplicate entity'); }
			return $entities[0];
		}
		public function insert(Entity $entity): Entity {
			$qb = $this->db->getQueryBuilder()->insert($this->table);
			foreach ($entity->getUpdatedFields() as $property => $_) {
				$getter = 'get' . ucfirst($property);
				$type = ($entity->getFieldTypes()[$property] ?? '') === 'integer' ? 1 : 2;
				$qb->setValue($entity->propertyToColumn($property), $qb->createNamedParameter($entity->$getter(), $type));
			}
			$qb->executeStatement();
			$entity->setId($qb->getLastInsertId());
			return $entity;
		}
		public function update(Entity $entity): Entity {
			throw new \LogicException('Record writes must use conditional SQL, not entity updates');
		}
	}
}

namespace TwentyFortyEightTests {
	class DatabaseException extends \OCP\DB\Exception {
		public function __construct(private int $reason) { parent::__construct('Fixture database error'); }
		public function getReason(): ?int { return $this->reason; }
	}
	class Database implements \OCP\IDBConnection {
		public \PDO $pdo;
		public $beforeExecute = null;
		public function __construct() {
			$this->pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
		}
		public function getQueryBuilder(): \OCP\DB\QueryBuilder\IQueryBuilder { return new QueryBuilder($this); }
	}
	class Expressions {
		public function eq(string $field, string $value): string { return '"' . $field . '" = ' . $value; }
		public function lt(string $field, string $value): string { return '"' . $field . '" < ' . $value; }
		public function gt(string $field, string $value): string { return '"' . $field . '" > ' . $value; }
	}
	class Functions {
		public function count(string $field, string $alias): string { return 'COUNT(' . $field . ') AS "' . $alias . '"'; }
	}
	class QueryBuilder implements \OCP\DB\QueryBuilder\IQueryBuilder {
		public string $operation = 'select';
		public string $table;
		public array $values = [];
		private array $parameters = [];
		private array $where = [];
		private array $order = [];
		private string $selection = '*';
		private ?int $limit = null;
		public function __construct(private Database $db) {}
		public function expr(): Expressions { return new Expressions(); }
		public function func(): Functions { return new Functions(); }
		public function createNamedParameter($value, int $type = self::PARAM_STR): string {
			$name = ':p' . count($this->parameters);
			$this->parameters[$name] = [$value, $type];
			return $name;
		}
		public function select(string $selection): static { $this->selection = $selection; return $this; }
		public function from(string $table): static { $this->table = $table; return $this; }
		public function update(string $table): static { $this->operation = 'update'; return $this->from($table); }
		public function insert(string $table): static { $this->operation = 'insert'; return $this->from($table); }
		public function delete(string $table): static { $this->operation = 'delete'; return $this->from($table); }
		public function set(string $field, string $value): static { $this->values[$field] = $value; return $this; }
		public function setValue(string $field, string $value): static { return $this->set($field, $value); }
		public function where(string $where): static { $this->where = [$where]; return $this; }
		public function andWhere(string $where): static { $this->where[] = $where; return $this; }
		public function orderBy(string $field, string $direction): static { $this->order = []; return $this->addOrderBy($field, $direction); }
		public function addOrderBy(string $field, string $direction): static { $this->order[] = '"' . $field . '" ' . $direction; return $this; }
		public function setMaxResults(int $limit): static { $this->limit = $limit; return $this; }
		public function getLastInsertId(): int { return (int)$this->db->pdo->lastInsertId(); }
		private function execute(): \PDOStatement {
			if ($this->db->beforeExecute !== null) { ($this->db->beforeExecute)($this); }
			$table = '"' . $this->table . '"';
			switch ($this->operation) {
				case 'select': $sql = 'SELECT ' . $this->selection . ' FROM ' . $table; break;
				case 'delete': $sql = 'DELETE FROM ' . $table; break;
				case 'insert':
					$sql = 'INSERT INTO ' . $table . ' ("' . implode('","', array_keys($this->values)) . '") VALUES (' . implode(',', $this->values) . ')';
					break;
				case 'update':
					$sets = [];
					foreach ($this->values as $field => $value) { $sets[] = '"' . $field . '" = ' . $value; }
					$sql = 'UPDATE ' . $table . ' SET ' . implode(',', $sets);
					break;
				default: throw new \LogicException($this->operation);
			}
			if ($this->where !== []) { $sql .= ' WHERE ' . implode(' AND ', $this->where); }
			if ($this->order !== []) { $sql .= ' ORDER BY ' . implode(',', $this->order); }
			if ($this->limit !== null) { $sql .= ' LIMIT ' . $this->limit; }
			try {
				$statement = $this->db->pdo->prepare($sql);
				foreach ($this->parameters as $name => [$value, $type]) { $statement->bindValue($name, $value, $type); }
				$statement->execute();
				return $statement;
			} catch (\PDOException $e) {
				if (str_contains($e->getMessage(), 'UNIQUE constraint failed')) {
					throw new DatabaseException(\OCP\DB\Exception::REASON_UNIQUE_CONSTRAINT_VIOLATION);
				}
				throw $e;
			}
		}
		public function executeStatement(): int { return $this->execute()->rowCount(); }
		public function executeQuery(): Result { return new Result($this->execute()); }
	}
	class Result {
		public function __construct(private \PDOStatement $statement) {}
		public function fetch() { return $this->statement->fetch(\PDO::FETCH_ASSOC); }
		public function fetchOne() { return $this->statement->fetchColumn(); }
		public function closeCursor(): void { $this->statement->closeCursor(); }
	}
	class Table {
		public array $columns = [];
		public array $primary = [];
		public array $indexes = [];
		public function addColumn(string $name, string $type, array $options): void { $this->columns[$name] = [$type, $options]; }
		public function setPrimaryKey(array $fields): void { $this->primary = $fields; }
		public function addUniqueIndex(array $fields, string $name): void { $this->indexes[$name] = [$fields, true]; }
		public function addIndex(array $fields, string $name): void { $this->indexes[$name] = [$fields, false]; }
	}
	class Schema implements \OCP\DB\ISchemaWrapper {
		public array $tables = [];
		public function hasTable(string $name): bool { return isset($this->tables[$name]); }
		public function createTable(string $name): Table { return $this->tables[$name] = new Table(); }
		public function apply(Database $db): void {
			foreach ($this->tables as $name => $table) {
				$columns = [];
				foreach ($table->columns as $column => [$type, $options]) {
					if ($options['autoincrement'] ?? false) {
						$columns[] = '"' . $column . '" INTEGER PRIMARY KEY AUTOINCREMENT';
						continue;
					}
					$sql = '"' . $column . '" ' . ($type === 'string' ? 'TEXT' : 'INTEGER');
					if ($options['notnull'] ?? false) { $sql .= ' NOT NULL'; }
					if (isset($options['default'])) { $sql .= ' DEFAULT ' . (int)$options['default']; }
					$columns[] = $sql;
				}
				$db->pdo->exec('CREATE TABLE "' . $name . '" (' . implode(',', $columns) . ')');
				foreach ($table->indexes as $index => [$fields, $unique]) {
					$db->pdo->exec('CREATE ' . ($unique ? 'UNIQUE ' : '') . 'INDEX "' . $index . '" ON "' . $name . '" ("' . implode('","', $fields) . '")');
				}
			}
		}
	}
	class User implements \OCP\IUser {
		public function __construct(private string $uid) {}
		public function getUID(): string { return $this->uid; }
		public function getDisplayName(): string { return $this->uid; }
	}
	class Config implements \OCP\IConfig {
		private array $values = [];
		public function getSystemValue(string $key, $default = '') { return $key === 'secret' ? 'fixture-instance-secret' : $default; }
		public function getAppValue(string $app, string $key, string $default = ''): string { return $this->values[$app][$key] ?? $default; }
		public function setAppValue(string $app, string $key, string $value): void { $this->values[$app][$key] = $value; }
	}
	class Clock implements \OCP\AppFramework\Utility\ITimeFactory {
		public function getTime(): int { return 1_800_000_000; }
	}
}

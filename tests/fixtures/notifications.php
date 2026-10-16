<?php
declare(strict_types=1);

namespace OCP\Notification {
	interface IManager {}
	interface INotification {}
	interface INotifier {}
	class UnknownNotificationException extends \InvalidArgumentException {}
}
namespace OCP\L10N { interface IFactory {} }
namespace Psr\Log { interface LoggerInterface {} }

namespace TwentyFortyEightTests {
	class Notification implements \OCP\Notification\INotification {
		public array $values = [];
		public function setDateTime(\DateTime $dateTime): self { $this->values['dateTime'] = $dateTime; return $this; }
		public function __call(string $name, array $args) {
			$key = lcfirst(substr($name, 3));
			if (str_starts_with($name, 'get')) return $this->values[$key] ?? null;
			$this->values[$key] = $args[0];
			if (isset($args[1])) $this->values[$key . 'Parameters'] = $args[1];
			return $this;
		}
	}
	class Notifications implements \OCP\Notification\IManager {
		public array $sent = [];
		public int $flushes = 0;
		public bool $fail = false;
		public bool $deferred = false;
		public function __construct(private ?Database $db = null) {
			if ($db) $db->pdo->exec('CREATE TABLE test_notifications (body TEXT NOT NULL)');
		}
		public function createNotification(): Notification { return new Notification(); }
		public function defer(): bool {
			$own = !$this->deferred;
			$this->deferred = true;
			return $own;
		}
		public function notify(\OCP\Notification\INotification $notification): void {
			if ($this->fail) throw new \RuntimeException('Notification insert failed');
			if ($this->db) {
				$stmt = $this->db->pdo->prepare('INSERT INTO test_notifications VALUES (?)');
				$stmt->execute([json_encode($notification->values)]);
			} else $this->sent[] = $notification;
		}
		public function flush(): void {
			if ($this->db && $this->db->pdo->inTransaction()) throw new \RuntimeException('Push before commit');
			$this->flushes++;
			$this->deferred = false;
		}
		public function stored(): array {
			return $this->db ? array_map(fn($body) => json_decode($body, true), $this->db->pdo->query('SELECT body FROM test_notifications')->fetchAll(\PDO::FETCH_COLUMN))
				: array_map(fn($notification) => $notification->values, $this->sent);
		}
	}
	class Logger implements \Psr\Log\LoggerInterface {
		public function warning($message, array $context = []): void {}
	}
	class Translations implements \OCP\L10N\IFactory {
		public function get($app, $language) {
			return new class {
				public function t($text, array $params = []): string { return $params === [] ? $text : vsprintf($text, $params); }
			};
		}
	}
	class Urls implements \OCP\IURLGenerator {
		public function linkToRouteAbsolute($route): string { return 'https://cloud.test/apps/twentyfortyeight/'; }
		public function imagePath($app, $file): string { return '/apps/' . $app . '/img/' . $file; }
		public function getAbsoluteURL($path): string { return 'https://cloud.test' . $path; }
	}
}

<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Game;

use InvalidArgumentException;
use JsonException;
use OCA\TwentyFortyEight\AppInfo\Application;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IConfig;

/** Signed, stateless session proofs bound to the authenticated Nextcloud user. */
final class GameSession {
	public const MAX_AGE = 90 * 24 * 60 * 60;
	private const CLOCK_SKEW = 300;

	public function __construct(
		private IConfig $config,
		private ITimeFactory $time,
	) {
	}

	public function issue(string $uid): array {
		return $this->issueForSeed($uid, random_int(1, 0xffffffff));
	}

	/** Keep the old board/history while moving a legacy game to the banked rewards. */
	public function upgrade(string $uid, string $token, array $actions): array {
		$legacy = $this->verify($uid, $token, $actions, true);
		if ($legacy['session']['version'] !== 1) {
			throw new InvalidArgumentException('Only legacy games can be upgraded');
		}
		return $this->issueForSeed($uid, $legacy['session']['seed'], $token);
	}

	/** Keep the generation in app config so deletion of user preferences cannot reset it. */
	public function revoke(string $uid): void {
		$this->config->setAppValue(Application::APP_ID, $this->generationKey($uid), bin2hex(random_bytes(16)));
	}

	/** Derives leaderboard data from the replay; reported score fields are never trusted. */
	public function verify(string $uid, string $token, array $actions, bool $includeSavedState = false): array {
		$data = $this->decodeToken($uid, $token);
		$engine = new GameEngine($data['s'], $data['v']);
		$result = $engine->replay($actions);
		if ($includeSavedState) {
			$result['savedState'] = $engine->savedState();
			$result['session'] = [
				'token' => $token,
				'seed' => $data['s'],
				'version' => $data['v'],
			];
			if (isset($data['p'])) {
				$result['session']['previousToken'] = $data['p'];
			}
		}
		return $result;
	}

	private function issueForSeed(string $uid, int $seed, ?string $previousToken = null): array {
		$data = ['v' => GameEngine::VERSION, 's' => $seed, 'iat' => $this->time->getTime()];
		if ($previousToken !== null) {
			$data['p'] = $previousToken;
		}
		$payload = $this->encode(json_encode($data, JSON_THROW_ON_ERROR));
		$session = [
			'token' => $payload . '.' . $this->signature($uid, $payload),
			'seed' => $seed,
			'version' => GameEngine::VERSION,
		];
		if ($previousToken !== null) {
			$session['previousToken'] = $previousToken;
		}
		return $session;
	}

	/** Parent metadata is signed too; an upgraded token cannot claim another game. */
	private function decodeToken(string $uid, string $token, bool $checkAge = true, bool $allowParent = true): array {
		if (strlen($token) > 512 || !preg_match('/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/D', $token, $parts)
			|| !hash_equals($this->signature($uid, $parts[1]), $parts[2])) {
			throw new InvalidArgumentException('Invalid game session');
		}
		$decoded = base64_decode(strtr($parts[1], '-_', '+/'), true);
		try {
			$data = $decoded === false ? null : json_decode($decoded, true, 8, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			throw new InvalidArgumentException('Invalid game session');
		}
		if (!is_array($data) || !in_array($data['v'] ?? null, [1, 2], true)
			|| !isset($data['s'], $data['iat']) || !is_int($data['s']) || !is_int($data['iat'])
			|| $data['s'] < 1 || $data['s'] > 0xffffffff
			|| count($data) !== (array_key_exists('p', $data) ? 4 : 3)) {
			throw new InvalidArgumentException('Unsupported or invalid game session');
		}
		if (array_key_exists('p', $data)) {
			if (!$allowParent || $data['v'] !== 2 || !is_string($data['p'])) {
				throw new InvalidArgumentException('Invalid previous game session');
			}
			// The new token has its own lifetime. Its signed parent must be a
			// genuine v1 token for this UID/seed, even after the parent's expiry.
			$parent = $this->decodeToken($uid, $data['p'], false, false);
			if ($parent['v'] !== 1 || $parent['s'] !== $data['s']) {
				throw new InvalidArgumentException('Invalid previous game session');
			}
		}
		$now = $this->time->getTime();
		if ($checkAge && ($data['iat'] > $now + self::CLOCK_SKEW || $data['iat'] < $now - self::MAX_AGE)) {
			throw new InvalidArgumentException('Game session has expired; start a new game');
		}
		return $data;
	}

	private function signature(string $uid, string $payload): string {
		$secret = (string)$this->config->getSystemValue('secret', '');
		if ($secret === '') {
			throw new \RuntimeException('Nextcloud system secret is not configured');
		}
		$generation = $this->config->getAppValue(Application::APP_ID, $this->generationKey($uid), '');
		return $this->encode(hash_hmac('sha256', Application::APP_ID . "\0" . $uid . "\0" . $generation . "\0" . $payload, $secret, true));
	}

	private function generationKey(string $uid): string {
		// A SHA-256 key also fits installations whose appconfig key limit is 64 bytes.
		return hash('sha256', 'game_generation_' . $uid);
	}

	private function encode(string $bytes): string {
		return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
	}
}

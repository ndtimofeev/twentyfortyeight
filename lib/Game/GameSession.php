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
		$seed = random_int(1, 0xffffffff);
		$payload = $this->encode(json_encode([
			'v' => GameEngine::VERSION,
			's' => $seed,
			'iat' => $this->time->getTime(),
		], JSON_THROW_ON_ERROR));
		return [
			'token' => $payload . '.' . $this->signature($uid, $payload),
			'seed' => $seed,
			'version' => GameEngine::VERSION,
		];
	}

	/** Keep the generation in app config so deletion of user preferences cannot reset it. */
	public function revoke(string $uid): void {
		$this->config->setAppValue(Application::APP_ID, $this->generationKey($uid), bin2hex(random_bytes(16)));
	}

	/** Derives leaderboard data from the replay; reported score fields are never trusted. */
	public function verify(string $uid, string $token, array $actions, bool $includeSavedState = false): array {
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
		if (!is_array($data) || count($data) !== 3 || ($data['v'] ?? null) !== GameEngine::VERSION
			|| !isset($data['s'], $data['iat']) || !is_int($data['s']) || !is_int($data['iat'])
			|| $data['s'] < 1 || $data['s'] > 0xffffffff) {
			throw new InvalidArgumentException('Unsupported or invalid game session');
		}
		$now = $this->time->getTime();
		if ($data['iat'] > $now + self::CLOCK_SKEW || $data['iat'] < $now - self::MAX_AGE) {
			throw new InvalidArgumentException('Game session has expired; start a new game');
		}
		$engine = new GameEngine($data['s']);
		$result = $engine->replay($actions);
		if ($includeSavedState) {
			$result['savedState'] = $engine->savedState();
			$result['session'] = [
				'token' => $token,
				'seed' => $data['s'],
				'version' => GameEngine::VERSION,
			];
		}
		return $result;
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

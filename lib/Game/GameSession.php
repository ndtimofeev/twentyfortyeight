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
	public const MAX_TOKEN_LENGTH = 1024;
	private const CLOCK_SKEW = 300;

	public function __construct(
		private IConfig $config,
		private ITimeFactory $time,
	) {
	}

	public function issue(string $uid): array {
		return $this->issueForSeed($uid, random_int(1, 0xffffffff));
	}

	/** Preserve the complete legacy prefix, then use the current rules. */
	public function upgrade(string $uid, string $token, array $actions): array {
		$data = $this->decodeToken($uid, $token);
		if ($data['v'] >= GameEngine::VERSION) {
			throw new InvalidArgumentException('Only legacy games can be upgraded');
		}
		$this->replayData($data, $actions);
		return $this->issueForSeed($uid, $data['s'], $token, count($actions));
	}

	/** Metadata checks signatures and age without requiring the signed prefix. */
	public function session(string $uid, string $token): array {
		return $this->metadata($token, $this->decodeToken($uid, $token));
	}

	/** An authenticated live child can finish its parent's offline history. */
	public function extendUpgrade(string $uid, string $token, string $previousToken, array $actions, string $sourceSession = ''): array {
		$data = $this->decodeToken($uid, $token);
		if ($data['v'] < 3 || ($data['p'] ?? null) !== $previousToken || count($actions) < $data['n']) {
			throw new InvalidArgumentException('Invalid legacy game extension');
		}
		if ($sourceSession !== '' && $sourceSession !== $previousToken) {
			$metadata = $this->metadata($token, $data);
			if (!in_array($sourceSession, $metadata['ancestorTokens'] ?? [], true)) {
				throw new InvalidArgumentException('Invalid source game session');
			}
			$parent = $data['_parent'];
			if ($parent['v'] === 3 && isset($parent['p'])) {
				if ($data['n'] !== $parent['n']) {
					throw new InvalidArgumentException('The parent already has newer-rules actions');
				}
				// No v3/v4 suffix has been played. Extend the earlier boundary too,
				// keeping the v1/v2 tail's original canonical rules and identity.
				$this->replayData($parent['_parent'], $actions);
				$renewed = $this->issueForSeed($uid, $data['s'], $parent['p'], count($actions), 3);
				return $this->issueForSeed($uid, $data['s'], $renewed['token'], count($actions));
			}
		}
		$this->replayData($data['_parent'], $actions);
		return $this->issueForSeed($uid, $data['s'], $previousToken, count($actions));
	}

	/** Keep the generation in app config so deletion of user preferences cannot reset it. */
	public function revoke(string $uid): void {
		$this->config->setAppValue(Application::APP_ID, $this->generationKey($uid), bin2hex(random_bytes(16)));
	}

	/** Derives leaderboard data from the replay; reported score fields are never trusted. */
	public function verify(string $uid, string $token, array $actions, bool $includeSavedState = false): array {
		$data = $this->decodeToken($uid, $token);
		$engine = $this->replayData($data, $actions);
		$result = $engine->replay([]);
		if ($includeSavedState) {
			$result['savedState'] = $engine->savedState();
			$result['session'] = $this->metadata($token, $data);
		}
		return $result;
	}

	private function issueForSeed(string $uid, int $seed, ?string $previousToken = null, ?int $cutover = null, int $version = GameEngine::VERSION): array {
		$data = ['v' => $version, 's' => $seed, 'iat' => $this->time->getTime()];
		if ($previousToken !== null) {
			$data['p'] = $previousToken;
			$data['n'] = $cutover;
		}
		$payload = $this->encode(json_encode($data, JSON_THROW_ON_ERROR));
		$token = $payload . '.' . $this->signature($uid, $payload);
		if (strlen($token) > self::MAX_TOKEN_LENGTH) {
			throw new InvalidArgumentException('Upgraded game session is too large');
		}
		return $this->session($uid, $token);
	}

	private function metadata(string $token, array $data): array {
		$session = ['token' => $token, 'seed' => $data['s'], 'version' => $data['v']];
		if (isset($data['p'])) {
			$session['previousToken'] = $data['p'];
		}
		if (isset($data['n'])) {
			$session['cutover'] = $data['n'];
		}
		if ($data['v'] === 3 && ($data['_parent']['v'] ?? null) === 2 && isset($data['_parent']['p'])) {
			$session['ancestorToken'] = $data['_parent']['p'];
		}
		if ($data['v'] >= 4) {
			if (isset($data['_parent']['n'])) $session['previousCutover'] = $data['_parent']['n'];
			$ancestor = $data['_parent'] ?? [];
			while (isset($ancestor['p'])) {
				$session['ancestorTokens'][] = $ancestor['p'];
				$ancestor = $ancestor['_parent'];
			}
		}
		return $session;
	}

	private function replayData(array $data, array $actions): GameEngine {
		// Validate the full proof before slicing: each part's own limit is not enough.
		if (!array_is_list($actions) || count($actions) > GameEngine::MAX_ACTIONS) {
			throw new InvalidArgumentException('Invalid action list or game is too long');
		}
		if ($data['v'] >= 3 && isset($data['p'])) {
			if (count($actions) < $data['n']) {
				throw new InvalidArgumentException('Game history is shorter than its rules cutover');
			}
			$engine = $this->replayData($data['_parent'], array_slice($actions, 0, $data['n']));
			$engine->upgradeRules($data['v']);
			$engine->replay(array_slice($actions, $data['n']));
		} else {
			$engine = new GameEngine($data['s'], $data['v']);
			$engine->replay($actions);
		}
		return $engine;
	}

	/** Parent metadata is signed too; an upgraded token cannot claim another game. */
	private function decodeToken(string $uid, string $token, bool $checkAge = true, int $depth = 0): array {
		if ($depth > 3 || strlen($token) > self::MAX_TOKEN_LENGTH || !preg_match('/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/D', $token, $parts)
			|| !hash_equals($this->signature($uid, $parts[1]), $parts[2])) {
			throw new InvalidArgumentException('Invalid game session');
		}
		$decoded = base64_decode(strtr($parts[1], '-_', '+/'), true);
		try {
			$data = $decoded === false ? null : json_decode($decoded, true, 8, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			throw new InvalidArgumentException('Invalid game session');
		}
		if (!is_array($data) || !in_array($data['v'] ?? null, [1, 2, 3, 4], true)
			|| !isset($data['s'], $data['iat']) || !is_int($data['s']) || !is_int($data['iat'])
			|| $data['s'] < 1 || $data['s'] > 0xffffffff
			|| count($data) !== (array_key_exists('p', $data) ? ($data['v'] >= 3 ? 5 : 4) : 3)) {
			throw new InvalidArgumentException('Unsupported or invalid game session');
		}
		if (array_key_exists('p', $data)) {
			if (!in_array($data['v'], [2, 3, 4], true) || !is_string($data['p'])
				|| ($data['v'] >= 3 && (!isset($data['n']) || !is_int($data['n']) || $data['n'] < 0 || $data['n'] > GameEngine::MAX_ACTIONS))) {
				throw new InvalidArgumentException('Invalid previous game session');
			}
			// The new token has its own lifetime. Its signed parent must be a
			// genuine old token for this UID/seed, even after the parent's expiry.
			$parent = $this->decodeToken($uid, $data['p'], false, $depth + 1);
			if ($parent['v'] >= $data['v'] || $parent['s'] !== $data['s']
				|| (isset($parent['n']) && $data['n'] < $parent['n'])) {
				throw new InvalidArgumentException('Invalid previous game session');
			}
			$data['_parent'] = $parent;
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

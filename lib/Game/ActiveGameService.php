<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Game;

use InvalidArgumentException;
use OCA\TwentyFortyEight\Db\ActiveGameMapper;
use OCP\AppFramework\Utility\ITimeFactory;

/** Authoritative saved boards are computed from a signed game and its history. */
class ActiveGameService {
	public function __construct(
		private ActiveGameMapper $mapper,
		private GameSession $sessions,
		private ITimeFactory $time,
	) {
	}

	public function get(string $uid): ?array {
		for ($attempt = 0; $attempt < 3; $attempt++) {
			$row = $this->mapper->findByUser($uid);
			if ($row === null) {
				return null;
			}
			try {
				// Only token validation is needed: state was replayed before the DB write.
				$verified = $this->sessions->verify($uid, $row['session_token'], [], true);
			} catch (InvalidArgumentException) {
				$this->mapper->deleteIfCurrent($uid, $row['session_token'], $row['revision']);
				continue;
			}
			$actions = json_decode($row['actions'], true, 512, JSON_THROW_ON_ERROR);
			if ($verified['session']['version'] === 1) {
				$session = $this->sessions->upgrade($uid, $row['session_token'], $actions);
				$upgraded = $this->sessions->verify($uid, $session['token'], $actions, true);
				$game = $this->game($upgraded, $actions, $row['revision'] + 1);
				if ($this->mapper->replace($uid, $row['session_token'], $row['revision'], $game, $this->time->getTime())) {
					return $game;
				}
				// A restart or another upgrader won the conditional write.
				continue;
			}
			$state = json_decode($row['state'], true, 512, JSON_THROW_ON_ERROR);
			// Preserve the empty JSON object used by the browser's milestone map.
			$state['reached'] = (object)$state['reached'];
			return [
				'session' => $verified['session'],
				'actions' => $actions,
				'revision' => $row['revision'],
				'state' => $state,
			];
		}
		throw new ActiveGameConflict('The saved game changed while it was being loaded. Try again.', null);
	}

	/** POST without restart restores an existing game instead of discarding it. */
	public function ensure(string $uid, bool $restart = false): array {
		$current = $this->get($uid);
		if ($current !== null && !$restart) {
			return $current;
		}
		// Seed and issue time form the signed identity; a restart must have a
		// distinct token even if random_int happens to repeat in the same second.
		for ($attempt = 0; $attempt < 3; $attempt++) {
			$session = $this->sessions->issue($uid);
			if ($current === null || !hash_equals($current['session']['token'], $session['token'])) {
				break;
			}
		}
		if ($current !== null && hash_equals($current['session']['token'], $session['token'])) {
			throw new \RuntimeException('Could not create a distinct game session');
		}
		$verified = $this->sessions->verify($uid, $session['token'], [], true);
		$fresh = $this->game($verified, [], 0);
		$stored = $current === null
			? $this->mapper->insert($uid, $fresh, $this->time->getTime())
			: $this->mapper->replace($uid, $current['session']['token'], $current['revision'], $fresh, $this->time->getTime());
		if ($stored) {
			return $fresh;
		}
		$winner = $this->get($uid);
		if (!$restart && $winner !== null) {
			return $winner;
		}
		throw new ActiveGameConflict('Another device changed the active game. Try again.', $winner);
	}

	public function save(string $uid, string $token, array $actions, int $revision): array {
		if ($revision < 0 || $revision === PHP_INT_MAX) {
			throw new InvalidArgumentException('Invalid game revision');
		}
		$verified = $this->sessions->verify($uid, $token, $actions, true);
		$current = $this->get($uid);
		if ($current === null) {
			// Adopt signed games previously stored only in this browser during upgrade.
			if ($verified['session']['version'] === 1) {
				$session = $this->sessions->upgrade($uid, $token, $actions);
				$verified = $this->sessions->verify($uid, $session['token'], $actions, true);
			}
			$adopted = $this->game($verified, $actions, 0);
			if ($revision === 0 && $this->mapper->insert($uid, $adopted, $this->time->getTime())) {
				return $adopted;
			}
			throw new ActiveGameConflict('The active game is no longer available.', $this->get($uid));
		}
		if (!hash_equals($current['session']['token'], $token)) {
			throw new ActiveGameConflict('A new game was started on another device.', $current);
		}
		if ($current['actions'] === $actions) {
			// The response to an earlier successful write may have been lost.
			return $current;
		}
		if (!$this->isPrefix($current['actions'], $actions) || $current['revision'] !== $revision) {
			throw new ActiveGameConflict('Another device has newer or different moves.', $current);
		}
		$saved = $this->game($verified, $actions, $revision + 1);
		if ($this->mapper->replace($uid, $token, $revision, $saved, $this->time->getTime())) {
			return $saved;
		}
		$winner = $this->get($uid);
		if ($winner !== null && hash_equals($winner['session']['token'], $token) && $winner['actions'] === $actions) {
			return $winner;
		}
		throw new ActiveGameConflict('Another device saved moves at the same time.', $winner);
	}

	private function game(array $verified, array $actions, int $revision): array {
		return [
			'session' => $verified['session'],
			'actions' => $actions,
			'revision' => $revision,
			'state' => $verified['savedState'],
		];
	}

	private function isPrefix(array $prefix, array $actions): bool {
		return count($prefix) <= count($actions) && $prefix === array_slice($actions, 0, count($prefix));
	}
}

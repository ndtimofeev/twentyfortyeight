<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Game;

use InvalidArgumentException;

/** Deterministic, versioned rules shared with the browser's recorded games. */
final class GameEngine {
	public const VERSION = 2;
	public const MAX_ACTIONS = 50_000;
	private const SIZE = 4;
	private const BONUS_MILESTONES = [128 => 'undo', 256 => 'swap', 512 => 'remove'];
	private const VECTORS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

	/** @var array<int, array<int, int>> Columns first, matching Grid.availableCells(). */
	private array $board;
	private int $rng;
	private int $score = 0;
	private int $moves = 0;
	private bool $won = false;
	private bool $over = false;
	private bool $keepPlaying = false;
	private array $bonuses = ['undo' => 2, 'swap' => 2, 'remove' => 2];
	private array $pendingBonuses = ['undo' => 0, 'swap' => 0, 'remove' => 0];
	private int $rulesVersion;
	private array $reached = [];
	private ?array $previous = null;
	private int $peakScore = 0;
	private int $movesAtPeakScore = 0;
	private int $bestTileEver = 0;

	public function __construct(int $seed, int $version = self::VERSION) {
		if (PHP_INT_SIZE < 8 || $seed < 1 || $seed > 0xffffffff) {
			throw new InvalidArgumentException('Invalid game seed');
		}
		if (!in_array($version, [1, 2], true)) {
			throw new InvalidArgumentException('Unsupported game rules version');
		}
		$this->rulesVersion = $version;
		$this->rng = $seed;
		$this->board = array_fill(0, self::SIZE, array_fill(0, self::SIZE, 0));
		$this->addRandomTile();
		$this->addRandomTile();
		$this->rememberStats();
	}

	public function getRulesVersion(): int {
		return $this->rulesVersion;
	}

	/**
	 * Replay only successful actions. Invalid actions make the entire proof invalid.
	 * A new engine must be used for each replay, including retries of the same proof.
	 */
	public function replay(array $actions): array {
		if (!array_is_list($actions) || count($actions) > self::MAX_ACTIONS) {
			throw new InvalidArgumentException('Invalid action list or game is too long');
		}
		foreach ($actions as $index => $action) {
			try {
				$this->applyAction($action);
			} catch (InvalidArgumentException $e) {
				throw new InvalidArgumentException('Invalid action at index ' . $index . ': ' . $e->getMessage(), 0, $e);
			}
			$this->rememberStats();
		}
		return [
			'peakScore' => $this->peakScore,
			'bestTileEver' => $this->bestTileEver,
			'movesAtPeakScore' => $this->movesAtPeakScore,
			'state' => $this->state(),
		];
	}

	/** State is exposed for cross-language conformance tests; never accepts client state. */
	public function state(): array {
		$state = [
			'board' => $this->board,
			'score' => $this->score,
			'moves' => $this->moves,
			'won' => $this->won,
			'over' => $this->over,
			'keepPlaying' => $this->keepPlaying,
			'bonuses' => $this->bonuses,
			'reached' => (object)$this->reached,
			'canUndo' => $this->previous !== null && $this->bonuses['undo'] > 0,
			'rng' => $this->rng,
		];
		if ($this->rulesVersion === 2) {
			$state['pendingBonuses'] = $this->pendingBonuses;
		}
		return $state;
	}

	/** Browser restoration state derived exclusively from verified actions. */
	public function savedState(): array {
		$previous = $this->previous === null ? null : [
			'grid' => $this->serializeGrid($this->previous['board']),
			'score' => $this->previous['score'],
			'moves' => $this->previous['moves'],
			'won' => $this->previous['won'],
			'over' => $this->previous['over'],
		];
		$state = [
			'grid' => $this->serializeGrid($this->board),
			'score' => $this->score,
			'over' => $this->over,
			'won' => $this->won,
			'keepPlaying' => $this->keepPlaying,
			'moves' => $this->moves,
			'maxTile' => $this->bestTileEver,
			'bonuses' => $this->bonuses,
			'reached' => (object)$this->reached,
			'previous' => $previous,
			'randomState' => $this->rng,
		];
		if ($this->rulesVersion === 2) {
			$state['pendingBonuses'] = $this->pendingBonuses;
		}
		$state['peakScore'] = $this->peakScore;
		return $state;
	}

	/** Grid.serialize()/Tile.serialize() shape, with columns before rows. */
	private function serializeGrid(array $board): array {
		$cells = [];
		foreach ($board as $x => $column) {
			$cells[$x] = [];
			foreach ($column as $y => $value) {
				$cells[$x][$y] = $value === 0 ? null : [
					'position' => ['x' => $x, 'y' => $y],
					'value' => $value,
				];
			}
		}
		return ['size' => self::SIZE, 'cells' => $cells];
	}

	private function applyAction(mixed $action): void {
		if (!is_array($action) || !array_is_list($action) || !isset($action[0]) || !is_string($action[0])) {
			throw new InvalidArgumentException('Expected an action array');
		}
		switch ($action[0]) {
			case 'move':
				if (count($action) !== 2 || !is_int($action[1]) || $action[1] < 0 || $action[1] > 3) {
					throw new InvalidArgumentException('Invalid move direction');
				}
				$this->move($action[1]);
				return;
			case 'undo':
				if (count($action) !== 1 || $this->previous === null || $this->bonuses['undo'] < 1) {
					throw new InvalidArgumentException('Undo is unavailable');
				}
				foreach ($this->previous as $key => $value) {
					$this->{$key} = $value;
				}
				$this->previous = null;
				$this->useBonusCharge('undo');
				return;
			case 'swap':
				if (count($action) !== 5) {
					throw new InvalidArgumentException('Invalid swap coordinates');
				}
				foreach (array_slice($action, 1) as $coordinate) {
					if (!is_int($coordinate) || $coordinate < 0 || $coordinate >= self::SIZE) {
						throw new InvalidArgumentException('Invalid swap coordinates');
					}
				}
				$this->swap($action[1], $action[2], $action[3], $action[4]);
				return;
			case 'remove':
				if (count($action) !== 2 || !is_int($action[1]) || $action[1] < 2) {
					throw new InvalidArgumentException('Invalid tile value');
				}
				$this->remove($action[1]);
				return;
			case 'continue':
				if (count($action) !== 1 || !$this->won || $this->over || $this->keepPlaying) {
					throw new InvalidArgumentException('Continue is unavailable');
				}
				$this->keepPlaying = true;
				return;
			default:
				throw new InvalidArgumentException('Unknown action');
		}
	}

	private function move(int $direction): void {
		if ($this->terminated()) {
			throw new InvalidArgumentException('Game is terminated');
		}
		$snapshot = [
			'board' => $this->board, 'score' => $this->score, 'moves' => $this->moves,
			'won' => $this->won, 'over' => $this->over,
		];
		[$dx, $dy] = self::VECTORS[$direction];
		$xs = $dx === 1 ? [3, 2, 1, 0] : [0, 1, 2, 3];
		$ys = $dy === 1 ? [3, 2, 1, 0] : [0, 1, 2, 3];
		$merged = array_fill(0, self::SIZE, array_fill(0, self::SIZE, false));
		$moved = false;
		foreach ($xs as $x) {
			foreach ($ys as $y) {
				$value = $this->board[$x][$y];
				if ($value === 0) {
					continue;
				}
				$fx = $x;
				$fy = $y;
				while ($this->inside($fx + $dx, $fy + $dy) && $this->board[$fx + $dx][$fy + $dy] === 0) {
					$fx += $dx;
					$fy += $dy;
				}
				$nx = $fx + $dx;
				$ny = $fy + $dy;
				if ($this->inside($nx, $ny) && $this->board[$nx][$ny] === $value && !$merged[$nx][$ny]) {
					$value *= 2;
					$this->board[$x][$y] = 0;
					$this->board[$nx][$ny] = $value;
					$merged[$nx][$ny] = true;
					$this->score += $value;
					$this->won = $this->won || $value === 2048;
					$this->awardBonus($value);
					$moved = true;
				} elseif ($fx !== $x || $fy !== $y) {
					$this->board[$x][$y] = 0;
					$this->board[$fx][$fy] = $value;
					$moved = true;
				}
			}
		}
		if (!$moved) {
			throw new InvalidArgumentException('Move does not change the board');
		}
		$this->previous = $snapshot;
		$this->moves++;
		$this->addRandomTile();
		if (!$this->movesAvailable()) {
			$this->over = true;
		}
	}

	private function swap(int $x1, int $y1, int $x2, int $y2): void {
		$a = $this->board[$x1][$y1];
		$b = $this->board[$x2][$y2];
		if ($this->terminated() || $this->bonuses['swap'] < 1 || $a === 0 || $b === 0 || $a === $b) {
			throw new InvalidArgumentException('Swap is unavailable for these tiles');
		}
		$this->board[$x1][$y1] = $b;
		$this->board[$x2][$y2] = $a;
		if (!$this->movesAvailable()) {
			$this->board[$x1][$y1] = $a;
			$this->board[$x2][$y2] = $b;
			throw new InvalidArgumentException('Swap would leave no moves');
		}
		$this->useBonusCharge('swap');
		$this->previous = null;
	}

	private function remove(int $value): void {
		if ($this->terminated() || $this->bonuses['remove'] < 1) {
			throw new InvalidArgumentException('Remove is unavailable');
		}
		$found = false;
		foreach ($this->board as $x => $column) {
			foreach ($column as $y => $tile) {
				if ($tile === $value) {
					$this->board[$x][$y] = 0;
					$found = true;
				}
			}
		}
		if (!$found) {
			throw new InvalidArgumentException('No tile has this value');
		}
		if (count($this->availableCells()) === self::SIZE * self::SIZE) {
			$this->addRandomTile();
			$this->addRandomTile();
		}
		$this->useBonusCharge('remove');
		$this->previous = null;
	}

	private function awardBonus(int $value): void {
		$type = self::BONUS_MILESTONES[$value] ?? null;
		if ($type !== null && !isset($this->reached[$value])) {
			$this->reached[$value] = true;
			if ($this->bonuses[$type] < 2) {
				$this->bonuses[$type]++;
			} elseif ($this->rulesVersion === 2) {
				$this->pendingBonuses[$type] = 1;
			}
		}
	}

	private function useBonusCharge(string $type): void {
		$this->bonuses[$type]--;
		if ($this->rulesVersion === 2 && $this->pendingBonuses[$type] === 1) {
			$this->pendingBonuses[$type] = 0;
			$this->bonuses[$type] = min(2, $this->bonuses[$type] + 1);
		}
	}

	private function terminated(): bool {
		return $this->over || ($this->won && !$this->keepPlaying);
	}

	private function movesAvailable(): bool {
		foreach ($this->board as $x => $column) {
			foreach ($column as $y => $value) {
				if ($value === 0
					|| ($x < self::SIZE - 1 && $this->board[$x + 1][$y] === $value)
					|| ($y < self::SIZE - 1 && $this->board[$x][$y + 1] === $value)) {
					return true;
				}
			}
		}
		return false;
	}

	private function inside(int $x, int $y): bool {
		return $x >= 0 && $x < self::SIZE && $y >= 0 && $y < self::SIZE;
	}

	private function availableCells(): array {
		$cells = [];
		foreach ($this->board as $x => $column) {
			foreach ($column as $y => $value) {
				if ($value === 0) {
					$cells[] = [$x, $y];
				}
			}
		}
		return $cells;
	}

	private function addRandomTile(): void {
		$cells = $this->availableCells();
		if ($cells === []) {
			return;
		}
		$value = $this->random() < 0.9 ? 2 : 4;
		[$x, $y] = $cells[(int)floor($this->random() * count($cells))];
		$this->board[$x][$y] = $value;
	}

	/** Xorshift32, unsigned after every step; next random is in [0, 1). */
	private function random(): float {
		$x = $this->rng;
		$x ^= ($x << 13) & 0xffffffff;
		$x ^= $x >> 17;
		$x ^= ($x << 5) & 0xffffffff;
		$this->rng = $x & 0xffffffff;
		return $this->rng / 4294967296;
	}

	private function rememberStats(): void {
		if ($this->score > $this->peakScore) {
			$this->peakScore = $this->score;
			$this->movesAtPeakScore = $this->moves;
		}
		foreach ($this->board as $column) {
			$this->bestTileEver = max($this->bestTileEver, ...$column);
		}
	}
}

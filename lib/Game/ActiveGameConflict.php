<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Game;

/** The client can reconcile a compatible history or display the other game. */
class ActiveGameConflict extends \RuntimeException {
	public function __construct(string $message, public readonly ?array $game) {
		parent::__construct($message);
	}
}

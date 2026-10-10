<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method int getScore()
 * @method void setScore(int $score)
 * @method int getBestTile()
 * @method void setBestTile(int $bestTile)
 * @method int getMoves()
 * @method void setMoves(int $moves)
 * @method int getUpdatedAt()
 * @method void setUpdatedAt(int $updatedAt)
 */
class Score extends Entity {
	protected $userId;
	protected $score;
	protected $bestTile;
	protected $moves;
	protected $updatedAt;

	public function __construct() {
		$this->addType('score', 'integer');
		$this->addType('bestTile', 'integer');
		$this->addType('moves', 'integer');
		$this->addType('updatedAt', 'integer');
	}
}

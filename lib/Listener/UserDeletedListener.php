<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Listener;

use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCA\TwentyFortyEight\Game\GameSession;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\User\Events\UserDeletedEvent;

/** @implements IEventListener<UserDeletedEvent> */
class UserDeletedListener implements IEventListener {
	public function __construct(private ScoreMapper $mapper, private GameSession $games) {
	}

	public function handle(Event $event): void {
		if ($event instanceof UserDeletedEvent) {
			$uid = $event->getUser()->getUID();
			$this->games->revoke($uid);
			$this->mapper->deleteByUser($uid);
		}
	}
}

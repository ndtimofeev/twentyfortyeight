<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Notification;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCP\IURLGenerator;
use OCP\IUserManager;
use OCP\L10N\IFactory;
use OCP\Notification\INotification;
use OCP\Notification\INotifier;
use OCP\Notification\UnknownNotificationException;

class Notifier implements INotifier {
	public function __construct(private IFactory $l10n, private IURLGenerator $url, private IUserManager $users) {
	}

	public function getID(): string { return Application::APP_ID; }
	public function getName(): string { return '2048'; }

	public function prepare(INotification $notification, string $languageCode): INotification {
		$params = $notification->getSubjectParameters();
		if ($notification->getApp() !== Application::APP_ID || $notification->getSubject() !== 'leader_lost'
			|| !is_string($params['user'] ?? null) || !is_int($params['score'] ?? null)) {
			throw new UnknownNotificationException();
		}
		$l = $this->l10n->get(Application::APP_ID, $languageCode);
		$name = $this->users->get($params['user'])?->getDisplayName() ?? $l->t('Another player');
		return $notification
			->setParsedSubject($l->t('You lost first place in 2048'))
			->setParsedMessage($l->t('%1$s overtook you with %2$s points.', [$name, (string)$params['score']]))
			->setLink($this->url->linkToRouteAbsolute('twentyfortyeight.page.index'))
			->setIcon($this->url->getAbsoluteURL($this->url->imagePath(Application::APP_ID, 'app.svg')));
	}
}

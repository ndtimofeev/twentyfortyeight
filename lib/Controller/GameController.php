<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Controller;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Game\GameSession;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;

class GameController extends Controller {
	public function __construct(
		IRequest $request,
		private GameSession $sessions,
		private IUserSession $userSession,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/** Authentication and CSRF checks are supplied by Nextcloud's route middleware. */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 30, period: 60)]
	public function create(): DataResponse {
		return new DataResponse($this->sessions->issue($this->userSession->getUser()->getUID()));
	}
}

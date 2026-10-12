<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Controller;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Game\ActiveGameConflict;
use OCA\TwentyFortyEight\Game\ActiveGameService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;

class GameController extends Controller {
	public function __construct(
		IRequest $request,
		private ActiveGameService $games,
		private IUserSession $userSession,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return $this->respond(fn () => $this->games->get($this->currentUid()));
	}

	/** Authentication and CSRF checks are supplied by Nextcloud's route middleware. */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 30, period: 60)]
	public function create(bool $restart = false): DataResponse {
		return $this->respond(fn () => $this->games->ensure($this->currentUid(), $restart));
	}

	#[NoAdminRequired]
	#[UserRateLimit(limit: 60, period: 60)]
	public function save(string $session, array $actions, int $revision): DataResponse {
		return $this->respond(fn () => $this->games->save($this->currentUid(), $session, $actions, $revision));
	}

	private function currentUid(): string {
		return $this->userSession->getUser()->getUID();
	}

	private function respond(callable $action): DataResponse {
		try {
			return new DataResponse(['game' => $action()]);
		} catch (ActiveGameConflict $e) {
			return new DataResponse(['message' => $e->getMessage(), 'game' => $e->game], 409);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['message' => $e->getMessage()], 400);
		}
	}
}

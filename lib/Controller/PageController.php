<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Controller;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCA\TwentyFortyEight\Db\ScoreMapper;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IURLGenerator $urlGenerator,
		private IUserSession $userSession,
		private ScoreMapper $mapper,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		Util::addStyle(Application::APP_ID, 'main');
		Util::addStyle(Application::APP_ID, 'bonuses');
		Util::addStyle(Application::APP_ID, 'leaderboard');
		// Upstream 2048 sources first, then the Nextcloud glue. Nothing here depends
		// on load order at definition time, only on everything being there at start.
		foreach ([
			'keyboard_input_manager',
			'html_actuator',
			'grid',
			'tile',
			'local_storage_manager',
			'leaderboard',
			'server_storage_manager',
			'bonus_ui',
			'seeded_random',
			'game_manager',
			'application',
		] as $script) {
			Util::addScript(Application::APP_ID, $script);
		}

		$uid = $this->userSession->getUser()->getUID();
		$best = $this->mapper->findByUser($uid);

		return new TemplateResponse(Application::APP_ID, 'main', [
			'scoresUrl' => $this->urlGenerator->linkToRoute(Application::APP_ID . '.score.index'),
			'gamesUrl' => $this->urlGenerator->linkToRoute(Application::APP_ID . '.game.create'),
			'best' => $best?->getScore() ?? 0,
			'bestTile' => $best?->getBestTile() ?? 0,
			'user' => $uid,
		]);
	}
}

<?php

declare(strict_types=1);

namespace OCA\TwentyFortyEight\Controller;

use OCA\TwentyFortyEight\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IURLGenerator $urlGenerator,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		Util::addStyle(Application::APP_ID, 'style');
		Util::addScript(Application::APP_ID, 'core');
		Util::addScript(Application::APP_ID, 'main');

		return new TemplateResponse(Application::APP_ID, 'main', [
			'scoresUrl' => $this->urlGenerator->linkToRoute(Application::APP_ID . '.score.index'),
		]);
	}
}

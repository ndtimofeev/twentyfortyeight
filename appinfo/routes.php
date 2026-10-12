<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
		['name' => 'game#index', 'url' => '/api/games', 'verb' => 'GET'],
		['name' => 'game#create', 'url' => '/api/games', 'verb' => 'POST'],
		['name' => 'game#save', 'url' => '/api/games', 'verb' => 'PUT'],
		['name' => 'score#index', 'url' => '/api/scores', 'verb' => 'GET'],
		['name' => 'score#submit', 'url' => '/api/scores', 'verb' => 'POST'],
	],
];

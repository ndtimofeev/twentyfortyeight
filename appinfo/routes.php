<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
		['name' => 'score#index', 'url' => '/api/scores', 'verb' => 'GET'],
		['name' => 'score#submit', 'url' => '/api/scores', 'verb' => 'POST'],
	],
];

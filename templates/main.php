<?php
/** @var array $_ */
?>
<div id="app-content">
	<div class="tfe" data-scores-url="<?php p($_['scoresUrl']); ?>">
		<div class="tfe-game">
			<div class="tfe-header">
				<h1>2048</h1>
				<div class="tfe-stats">
					<div class="tfe-stat"><span>Score</span><strong id="tfe-score">0</strong></div>
					<div class="tfe-stat"><span>Best</span><strong id="tfe-best">0</strong></div>
				</div>
			</div>
			<div class="tfe-actions">
				<p>Join the numbers and get to the <strong>2048</strong> tile! Use the arrow keys, WASD or swipe.</p>
				<button type="button" id="tfe-new" class="primary">New game</button>
			</div>
			<div class="tfe-board" id="tfe-board">
				<div class="tfe-cells">
					<?php for ($i = 0; $i < 16; $i++): ?><div class="tfe-cell"></div><?php endfor; ?>
				</div>
				<div class="tfe-tiles" id="tfe-tiles"></div>
				<div class="tfe-message" id="tfe-message" hidden>
					<p id="tfe-message-text"></p>
					<div>
						<button type="button" id="tfe-continue" class="primary" hidden>Keep going</button>
						<button type="button" id="tfe-retry">Try again</button>
					</div>
				</div>
			</div>
		</div>
		<aside class="tfe-leaderboard">
			<h2>Leaderboard</h2>
			<p id="tfe-me" class="tfe-me"></p>
			<ol id="tfe-list"></ol>
			<p id="tfe-empty" hidden>No scores yet. Be the first!</p>
		</aside>
	</div>
</div>

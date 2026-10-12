<?php
/** @var array $_ */
?>
<div id="app-content">
	<div id="tfe"
		data-scores-url="<?php p($_['scoresUrl']); ?>"
		data-games-url="<?php p($_['gamesUrl']); ?>"
		data-best="<?php p($_['best']); ?>"
		data-best-tile="<?php p($_['bestTile']); ?>"
		data-user="<?php p($_['user']); ?>">
		<div class="tfe-wrap">
			<div class="container" id="tfe-game">
				<div class="above-game">
					<div class="current-score">
						<span class="score-label" id="tfe-score-label">Score</span>
						<output class="score-container" aria-labelledby="tfe-score-label" aria-live="polite" aria-atomic="true">0</output>
					</div>
					<button type="button" class="restart-button">New Game</button>
				</div>
				<p class="tfe-status" role="status" aria-live="polite"></p>

				<div class="game-container">
					<div class="game-message">
						<p role="status" aria-live="polite"></p>
						<div class="lower">
							<button type="button" class="keep-playing-button">Keep going</button>
							<button type="button" class="retry-button">Try again</button>
						</div>
					</div>

					<div class="grid-container" role="grid" aria-label="2048 board" aria-rowcount="4" aria-colcount="4">
						<?php for ($row = 0; $row < 4; $row++): ?>
						<div class="grid-row" role="row">
							<?php for ($column = 0; $column < 4; $column++): ?>
							<div class="grid-cell" role="gridcell" tabindex="-1" aria-rowindex="<?php p($row + 1); ?>" aria-colindex="<?php p($column + 1); ?>"></div>
							<?php endfor; ?>
						</div>
						<?php endfor; ?>
					</div>

					<div class="tile-container" aria-hidden="true"></div>
				</div>

				<div class="bonus-bar">
					<button type="button" class="bonus-button" data-bonus="undo" title="Undo the last move. Earn one charge at the first 128 tile; it is held if the two ready charges are full.">
						<span class="bonus-name">Undo</span><span class="bonus-count">2</span>
					</button>
					<button type="button" class="bonus-button" aria-pressed="false" data-bonus="swap" title="Swap two tiles. Earn one charge at the first 256 tile; it is held if the two ready charges are full.">
						<span class="bonus-name">Swap</span><span class="bonus-count">2</span>
					</button>
					<button type="button" class="bonus-button" aria-pressed="false" data-bonus="remove" title="Remove all tiles with one value. Earn one charge at the first 512 tile; it is held if the two ready charges are full.">
						<span class="bonus-name">Remove</span><span class="bonus-count">2</span>
					</button>
				</div>
				<p class="bonus-hint" role="status" aria-live="polite" hidden></p>
			</div>

			<aside class="tfe-leaderboard">
				<h2>Leaderboard</h2>
				<p id="tfe-me" class="tfe-me"></p>
				<ol id="tfe-list" role="list"></ol>
				<p id="tfe-empty" hidden>No scores yet. Be the first!</p>
			</aside>
		</div>
	</div>
</div>

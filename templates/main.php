<?php
/** @var array $_ */
?>
<div id="app-content">
	<div id="tfe"
		data-scores-url="<?php p($_['scoresUrl']); ?>"
		data-best="<?php p($_['best']); ?>"
		data-user="<?php p($_['user']); ?>">
		<div class="tfe-wrap">
			<div class="container" id="tfe-game">
				<div class="above-game">
					<a class="restart-button">New Game</a>
				</div>

				<div class="game-container">
					<div class="game-message">
						<p></p>
						<div class="lower">
							<a class="keep-playing-button">Keep going</a>
							<a class="retry-button">Try again</a>
						</div>
					</div>

					<div class="grid-container">
						<?php for ($row = 0; $row < 4; $row++): ?>
						<div class="grid-row">
							<div class="grid-cell"></div>
							<div class="grid-cell"></div>
							<div class="grid-cell"></div>
							<div class="grid-cell"></div>
						</div>
						<?php endfor; ?>
					</div>

					<div class="tile-container"></div>
				</div>

				<div class="bonus-bar">
					<button type="button" class="bonus-button" data-bonus="undo" title="Undo the last move. One more charge at the 128 tile.">
						<span class="bonus-name">Undo</span><span class="bonus-count">2</span>
					</button>
					<button type="button" class="bonus-button" data-bonus="swap" title="Swap two tiles. One more charge at the 256 tile.">
						<span class="bonus-name">Swap</span><span class="bonus-count">2</span>
					</button>
					<button type="button" class="bonus-button" data-bonus="remove" title="Remove all tiles with one value. One more charge at the 512 tile.">
						<span class="bonus-name">Remove</span><span class="bonus-count">2</span>
					</button>
				</div>
				<p class="bonus-hint" hidden></p>
			</div>

			<aside class="tfe-leaderboard">
				<h2>Leaderboard</h2>
				<p id="tfe-me" class="tfe-me"></p>
				<ol id="tfe-list"></ol>
				<p id="tfe-empty" hidden>No scores yet. Be the first!</p>
			</aside>
		</div>
	</div>
</div>

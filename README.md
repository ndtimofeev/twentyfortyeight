# 2048 for Nextcloud

The 2048 puzzle game as a Nextcloud app, with a leaderboard shared by all users
of the instance.

* Each user's best score (plus best tile and move count) is stored in the
  `twentyfortyeight_scores` table; one row per user.
* The leaderboard shows the top 20 and the current user's place.
* The running game is kept in the browser's `localStorage` (per Nextcloud user),
  so a reload doesn't lose it.
* **Bonuses** (buttons under the board, two charges each, never more than two):
  * *Undo* takes back the last move (one level); one more charge when the first
    128 tile of a game is made.
  * *Swap* trades two tiles with different values; one more charge at the first 256.
    A swap that would leave no moves is refused.
  * *Remove* deletes all tiles with the value of the picked tile; one more charge
    at the first 512.

  A charge is earned only the first time that tile is made in a game, and neither
  charges nor that record are rolled back by Undo (otherwise undo + redo would
  farm charges). Swap and Remove are not moves: no new tile appears, and they
  clear the undo snapshot. On the game over / win screen only Undo works. Charges,
  the undo snapshot and the biggest tile are saved with the running game.
* **Scores are submitted by the client and are not verified.** Anyone can post a
  fake score. Only basic sanity limits are enforced. Replay validation (seeded
  RNG + server-side re-play of the moves) is a possible future step.

## Layout

```
appinfo/        info.xml, routes.php
lib/            controllers, entity/mapper, DB migration
templates/      main.php
js/             original 2048 sources + Nextcloud glue (see below)
css/main.css    original 2048 stylesheet, scoped to #tfe
css/bonuses.css, css/leaderboard.css
tests/          `npm test`: rules of the bonuses (node:test, DOM stubbed in a vm)
```

## Origin of the game code

The game is [gabrielecirulli/2048](https://github.com/gabrielecirulli/2048)
(MIT, see `LICENSE-2048.txt`). Differences from upstream:

* `grid.js`, `tile.js`, `local_storage_manager.js`: unchanged.
* `keyboard_input_manager.js`: ignores key presses while focus is in an input field;
  emits a `tap` event for touch taps (its touchstart handler suppresses clicks).
* `html_actuator.js`: skips the score boxes when they are missing.
* `game_manager.js`: counts moves and passes `{bestTile, moves}` to
  `setBestScore()`; the bonus rules (`undo`, `swapTiles`, `removeTilesOfValue`,
  charges, undo snapshot) live at the bottom and are saved in `serialize()`.
* `application.js`: uses `ServerStorageManager`.
* New: `server_storage_manager.js` (best score from/to the server, debounced POST,
  game state still in localStorage), `leaderboard.js`, and `bonus_ui.js` (bonus
  buttons, tile picking).
* `css/main.css`: every selector is prefixed with `#tfe`, the page-wide `html`/`body`
  rules and the bundled Clear Sans font are dropped (Nextcloud's font is used),
  text colour follows the Nextcloud theme.
* Polyfills for old browsers and the "official version" note are removed.
* Corners of tiles, cells, buttons and the board are slightly rounder (6px / 10px).
* The page shows the board, New Game, the bonus buttons and the leaderboard: the
  title, score/best boxes, intro, "How to play" and credits paragraphs are removed
  from the template (the copyright notice stays in `LICENSE-2048.txt`), together with
  the CSS for them. `html_actuator.js` skips the score boxes when they are missing.
  The best score is still tracked and sent to the server.

## Install for development

Copy or symlink this directory into `apps/` (or `custom_apps/`) of a Nextcloud
server as `twentyfortyeight`, then `occ app:enable twentyfortyeight`.

## TODO

* Add the AGPL-3.0 `LICENSE` text (required by the App Store).
* Translations (`l10n/`), currently English only.
* Verify `min-version`/`max-version` in `appinfo/info.xml` (currently 31-34; only tried on 34 by the maintainers, not by CI).
* Release signing / packaging for the App Store.

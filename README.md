# 2048 for Nextcloud

The 2048 puzzle game as a Nextcloud app, with a leaderboard shared by all users
of the instance.

* Each user's verified best score, largest tile and move count at the score
  record are stored in `twentyfortyeight_records`; one row per user. Updates
  cannot lower a record, including concurrent submissions from several tabs.
* The leaderboard shows 20 users and the current user's place. Equal scores
  share a place: `1, 1, 3`. Time and user ID only determine display order within
  a tie.
* The running game is kept in the browser's `localStorage` (per Nextcloud user),
  so a reload doesn't lose it. Storage is also separated by the installation's
  URL. Games do not sync between devices.
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
  clear the undo snapshot. If Remove clears the entire board, two starting
  tiles appear so the game can continue. On the game over / win screen only
  Undo works. Charges, the undo snapshot, the biggest tile and the Keep going
  choice are saved with the running game.
* All controls work with a keyboard. In Swap/Remove mode, arrows select a cell,
  Enter/Space picks a tile and Escape cancels. Ordinary moves use arrows,
  WASD or HJKL; R starts a new game.

## Verified scores and offline recovery

The server issues a random seed and a signed game token bound to the logged-in
user. The browser records successful moves and bonus actions. When submitted,
the server reproduces the game with the same unsigned 32-bit xorshift generator
and computes the score, tile record and move count itself. Client-reported
scores and board contents are never used for the leaderboard. Undo retains a
previously achieved record, but does not restore bonus charges or RNG state.

`POST /api/games` returns `{token, seed, version}`. `POST /api/scores` accepts
`{session: token, actions: [...]}`; actions are `['move', direction]`, `['undo']`,
`['swap', x1, y1, x2, y2]`, `['remove', value]`, or `['continue']`.
Both routes require Nextcloud authentication and CSRF protection and are rate
limited. A game token lasts 90 days; a game is limited to 50,000 successful
actions. Deleting an account revokes its tokens and removes its records.

A connection is required to start a new verified game. An existing saved game
can continue offline. Pending submissions are kept separately from the board,
survive restart/reload, and retry after network failures. Tile records are sent
even if the score is below the personal record. Permanent verification errors
remain visible and the affected submission is kept locally. Browser storage
must remain available; clearing it discards the unfinished game and pending
submissions. If storage is full, keep the page open until the result is saved.

Verification proves that a result is achievable with the issued seed and the
game rules. It does not prove human play or prevent automation, looking ahead
at the deterministic random sequence, or trying alternative valid histories.

### Upgrade from 0.1.0

Version 0.2.0 starts a new verified leaderboard. Earlier client-reported scores
cannot be verified retrospectively: they remain archived in
`twentyfortyeight_scores` and are not copied into the new leaderboard. Old
browser saves remain under their original keys; start a new game to join the
verified leaderboard. Installation migrations do not delete the legacy data.

## Layout

```
appinfo/        info.xml, routes.php
lib/            controllers, entity/mapper, migrations, replay engine and sessions
templates/      main.php
js/             original 2048 sources + Nextcloud glue (see below)
css/main.css    original 2048 stylesheet, scoped to #tfe
css/bonuses.css, css/leaderboard.css
tests/          JS rules/storage/UI tests, PHP/SQLite tests, JS/PHP replay fixtures
scripts/        isolated Nextcloud integration test and proof generator
.github/        CI and installable archive artifact
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
* `application.js`: uses `ServerStorageManager`; game initialization waits for a
  server-issued session. `seeded_random.js` provides deterministic random tiles.
* New: `server_storage_manager.js` (best score from/to the server, debounced POST,
  game state and persistent submission queue in localStorage), `leaderboard.js`,
  and `bonus_ui.js` (bonus buttons, mouse/touch/keyboard tile picking).
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

The application has no npm or Composer dependencies and no compilation step.

## Checks

With Node.js 22+ and PHP 8.3+ with PDO SQLite:

```
npm test
php tests/backend.php
php tests/replay.php
```

The replay tests compare server output against fixtures generated by the actual
browser GameManager, including random state, bonuses, Undo and continuation.
Regenerate them with:

```
node tests/generate_replay_fixtures.js > tests/fixtures/replay.json
```

For a real, disposable Nextcloud installation, with Docker, curl, Python 3,
Node.js and tar installed:

```
bash scripts/test-nextcloud.sh 31
```

CI runs syntax and unit checks, builds an installable archive, and exercises
the application on Nextcloud 31, 32, 33 and 34. Integration tests use temporary
users and containers and do not connect to an existing instance.
The Nextcloud 34 job also uses Playwright/Chromium to check real browser startup,
keyboard bonuses, seeded restoration and restart. Playwright is only a test
tool and is not included in the application archive.

## License

The Nextcloud application is AGPL-3.0-or-later; see `LICENSE`. The original 2048
sources retain their MIT license and copyright notice in `LICENSE-2048.txt`.

## TODO

* Translations (`l10n/`), currently English only.
* Release signing / packaging for the App Store.

# 2048 for Nextcloud

The 2048 puzzle game as a Nextcloud app, with a leaderboard shared by all users
of the instance.

* Each user's verified best score, largest tile and move count at the score
  record are stored in `twentyfortyeight_records`; one row per user. Updates
  cannot lower a record, including concurrent submissions from several tabs.
* The leaderboard shows 20 users and the current user's place. Equal scores
  share a place: `1, 1, 3`. Time and user ID only determine display order within
  a tie.
* Each Nextcloud user has one active game stored on the server, including its
  board, score, bonuses, Undo snapshot and random state. Opening the app in
  another browser or device resumes that game. Browser `localStorage`, separated
  by user and installation URL, also keeps a copy for offline play.
* **Bonuses** (buttons under the board, two charges each):
  * *Undo* takes back the last move, Swap or Remove (one level); each new 128 tile
    earns a charge.
  * *Swap* trades two tiles with different values; each new 256 tile earns a charge.
    A swap that would leave no moves is refused.
  * *Remove* deletes all tiles with the value of the picked tile; one more charge
    for each new 512 tile.

  Each qualifying merge adds one charge when fewer than two remain. With two
  charges, the reward is discarded; there is no reserve. Two qualifying merges
  in one move are handled separately, so a supply of zero can become two.
  Undo spends one charge. Cancelling Swap or Remove returns its spent charge;
  cancelling a move keeps the charges earned by its merges. Repeating a
  qualifying merge after Undo earns a charge again if there is room.
  Swap and Remove are not moves: no new tile appears, and their pre-action
  board is saved for Undo. Undo cannot undo itself. If Remove clears the entire
  board, two starting tiles appear so the game can continue. On the game over / win screen only
  Undo works. Charges, the undo snapshot, the biggest tile and
  the Keep going choice are saved with the running game.
* All controls work with a keyboard. In Swap/Remove mode, arrows select a cell,
  Enter/Space picks a tile and Escape cancels. Ordinary moves use arrows,
  WASD or HJKL; R starts a new game.

## Verified scores and offline recovery

The server issues a random seed and a signed game token bound to the logged-in
user. The browser records successful moves and bonus actions. When submitted,
the server reproduces the game with the same unsigned 32-bit xorshift generator
and computes the score, tile record and move count itself. Client-reported
scores and board contents are never used for the leaderboard. Undo retains a
previously achieved record and the forward RNG state. Only a cancelled
Swap/Remove refunds its own charge; Undo always spends one charge.

`GET /api/games` returns `{game: null}` or the active game. `POST /api/games`
ensures an active game exists; `{restart: true}` explicitly starts a new one.
The response contains `{game: {session: {token, seed, version}, actions,
revision, state}}`. `PUT /api/games` accepts `{session: token, actions, revision}`
and saves a verified extension of the active history. Its state is reconstructed
on the server, including Undo and the next random tile. Updates use a revision
check: a stale or different history gets HTTP 409 with the current game, so
concurrent browsers cannot overwrite each other's progress.

`POST /api/scores` accepts
`{session: token, actions: [...]}`; actions are `['move', direction]`, `['undo']`,
`['swap', x1, y1, x2, y2]`, `['remove', value]`, or `['continue']`.
The routes require Nextcloud authentication and CSRF protection and are rate
limited. A game token lasts 90 days; a game is limited to 50,000 successful
actions. Deleting an account revokes its tokens and removes its records and
active game.

Rules version 4 also allows Undo after Swap/Remove and refunds the cancelled
bonus. Rules version 3 awards charges for every qualifying merge. Versions 1, 2
and 3 proofs still replay with their original rules, so older pending score
submissions remain verifiable. Loading an older active game upgrades its future actions to
version 4. Its seed, board, score, ready charges and history are preserved; the
version 2 reserve is removed. The signed replacement session includes
`previousToken` and `cutover`, the number of actions verified under the old rules.
Version-4 sessions also include `ancestorTokens` when their signed parent has
older ancestors, so offline histories from versions 1, 2 or 3 remain linked.
Existing version-3 proofs keep their original `ancestorToken` metadata.
Compatible unsent old-rule actions are uploaded with `upgradeFrom: oldToken`
and `sourceSession` identifying their original signed session before the browser
switches rules. When a v1/v2 tail crosses an unplayed v3 boundary, both signed
cutovers are extended. `previousCutover` exposes that earlier boundary; a suffix
already played under v3 prevents its reinterpretation. The server may extend
the cutover only while no actions under the new rules have been saved. Otherwise,
the current server game wins and the older local history is backed up.

A connection is required to start a new verified game. An existing saved game
can continue offline. Successful actions are saved after a short debounce,
including moves that do not improve a personal record. The active game is
refreshed when returning to the app. Compatible offline progress is uploaded;
if another browser has started a new game or followed a different history, the
server's current game is loaded. The older history still has its own score
submission and cannot replace the active game.

Pending submissions are kept separately from the board,
survive restart/reload, and retry after network failures. Tile records are sent
even if the score is below the personal record. Rejected submissions remain
saved locally for diagnosis; save status messages are not shown in the game
interface. Clearing browser storage discards unsent offline progress and pending
submissions; the last server-saved game can still be restored. If browser
storage is full, pending results can only survive while
the page remains open until a successful submission.

Local boards also have immutable checkpoints. A longer compatible history
survives late acknowledgements and concurrent cache writes from another tab,
including an offline reload. Covered checkpoints are compacted only after their
replacement is durable. Divergent histories and earlier games remain separate;
the current server game determines which compatible history can resume online.

Verification proves that a result is achievable with the issued seed and the
game rules. It does not prove human play or prevent automation, looking ahead
at the deterministic random sequence, or trying alternative valid histories.

### Upgrade from 0.1.0

Version 0.2.0 starts a new verified leaderboard. Earlier client-reported scores
cannot be verified retrospectively: they remain archived in
`twentyfortyeight_scores` and are not copied into the new leaderboard. Old
browser saves remain under their original keys; start a new game to join the
verified leaderboard. Installation migrations do not delete the legacy data.

Version 0.3.0 adds server storage for active games. An existing signed browser
game is adopted when the account has no active server game yet; verified
leaderboard records are retained.

Version 0.4.0 introduced rules version 2 with one reserved first-milestone charge.

Version 0.5.0 introduces rules version 3: every qualifying merge replenishes its
bonus when the supply is below two. Existing active games switch rules without
resetting their board or action history. An offline version 1 or 2 game keeps
its original rules until it reconnects and completes the upgrade.

Version 0.5.1 protects local checkpoints from concurrent tabs and releases the
old migration's input lock when another device replaces the active game.

Version 0.6.0 introduces rules version 4. Newly used Swap and Remove can be
cancelled with Undo, returning their charge. Existing signed histories retain
every previous rules cutover and preserve the old Undo snapshot at upgrade;
the new bonus snapshots apply to actions played under version 4. The database
migration widens the active-session token to fit the complete signed chain.

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
* New: `server_storage_manager.js` (server records, shared active game with
  revision checks, offline state and persistent submission queue), `leaderboard.js`,
  and `bonus_ui.js` (bonus buttons, mouse/touch/keyboard tile picking).
* `css/main.css`: every selector is prefixed with `#tfe`, the page-wide `html`/`body`
  rules and the bundled Clear Sans font are dropped (Nextcloud's font is used),
  text colour follows the Nextcloud theme.
* Polyfills for old browsers and the "official version" note are removed.
* Corners of tiles, cells, buttons and the board are slightly rounder (6px / 10px).
* The page shows the current score above the board, New Game, the bonus buttons
  and the leaderboard. The title, best-score box, intro, "How to play" and credits
  paragraphs are removed (the copyright notice stays in `LICENSE-2048.txt`).
  On mobile the square board fills the available width with 16px side margins;
  the leaderboard
  follows below it. Save status messages are kept out of the game interface;
  the best score is still tracked and sent to the server.

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
keyboard bonuses, seeded restoration, shared games across browser contexts,
concurrent-tab offline recovery and restart. Playwright is only a test
tool and is not included in the application archive.

## License

The Nextcloud application is AGPL-3.0-or-later; see `LICENSE`. The original 2048
sources retain their MIT license and copyright notice in `LICENSE-2048.txt`.

## TODO

* Translations (`l10n/`), currently English only.
* Release signing / packaging for the App Store.

# 2048 for Nextcloud

The 2048 puzzle game as a Nextcloud app, with a leaderboard shared by all users
of the instance.

* Each user's best score (plus best tile and move count) is stored in the
  `twentyfortyeight_scores` table; one row per user.
* The leaderboard shows the top 20 and the current user's place.
* The running game is kept in the browser's `localStorage`, so a reload doesn't
  lose it.
* **Scores are submitted by the client and are not verified.** Anyone can post a
  fake score. Only basic sanity limits are enforced. Replay validation (seeded
  RNG + server-side re-play of the moves) is a possible future step.

## Layout

```
appinfo/        info.xml, routes.php
lib/            controllers, entity/mapper, DB migration
templates/      main.php
js/core.js      game rules (no DOM, tested with node)
js/main.js      UI, input, API calls
css/style.css
tests/          node --test tests/core.test.js
```

The game logic is an independent implementation of the 2048 rules, not a copy of
the original code.

## Install for development

Copy or symlink this directory into `apps/` (or `custom_apps/`) of a Nextcloud
server as `twentyfortyeight`, then `occ app:enable twentyfortyeight`.

## TODO

* Add the AGPL-3.0 `LICENSE` text (required by the App Store).
* Translations (`l10n/`), currently English only.
* Verify `min-version`/`max-version` in `appinfo/info.xml` against current releases.
* Release signing / packaging for the App Store.

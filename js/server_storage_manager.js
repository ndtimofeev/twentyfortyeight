// Scores are verified by replaying a server-issued game and its action log.
// Keep submissions separate from the board: restarting must not discard a game
// whose submission is still offline or in flight.
function ServerStorageManager() {
  this.root = document.getElementById("tfe");
  this.local = new LocalStorageManager();
  this.scoresUrl = this.root.dataset.scoresUrl;
  this.gamesUrl = this.root.dataset.gamesUrl;
  this.best = parseInt(this.root.dataset.best, 10) || 0;
  this.bestTile = parseInt(this.root.dataset.bestTile, 10) || 0;
  this.submitted = this.best;
  this.submittedTile = this.bestTile;
  this.session = null;
  this.actions = [];
  this.gamePeakScore = 0;
  this.gameBestTile = 0;
  this.gameRevision = 0;
  this.revision = 0;
  this.gameGeneration = 0;
  this.appliedGameSequence = 0;
  this.gameSavedActions = [];
  this.activeState = null;
  this.gameDirty = false;
  this.gameTimer = null;
  this.gameTimerDue = 0;
  this.gameAdopting = false;
  this.gameInFlight = null;
  this.gameRefreshInFlight = null;
  this.gameRetryAttempts = 0;
  this.gameRetryAt = 0;
  this.gamePaused = false;
  this.gameTransitioning = false;
  this.gamePromotion = null;
  this.gameConflictAttempts = 0;
  this.preparingGame = false;
  this.restartRequested = false;
  this.gameListeners = [];
  this.timer = null;
  this.timerDue = 0;
  this.inFlight = null;
  this.requestSequence = 0;
  this.appliedSequence = 0;
  this.queue = [];
  this.queueDirty = false;
  this.dirtyProofs = Object.create(null);
  this.removedProofs = Object.create(null);
  this.acknowledgedProofs = Object.create(null);
  this.persistedProofs = Object.create(null);
  this.jobCounter = 0;
  this.persistent = this.local.storage !== window.fakeStorage;
  this.leaderboard = new Leaderboard(document.getElementById("tfe-list"),
                                     document.getElementById("tfe-me"),
                                     document.getElementById("tfe-empty"));

  // Separate installations in different paths may share an origin and UID.
  var identity = encodeURIComponent(this.scoresUrl) + "." + encodeURIComponent(this.root.dataset.user);
  this.local.gameStateKey = "twentyfortyeight.gameState." + identity;
  this.draftKey = this.local.gameStateKey + ".draft.";
  this.currentGameKey = this.local.gameStateKey + ".current";
  this.queueKey = "twentyfortyeight.submissions." + identity;
  this.readQueue(true);

  var self = this;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      self.flush(true);
      self.flushGame(true);
    } else self.refreshGame();
  });
  window.addEventListener("pagehide", function () { self.flush(true); self.flushGame(true); });
  window.addEventListener("focus", function () { self.refreshGame(); });
  window.addEventListener("online", function () {
    self.readQueue();
    self.queue.forEach(function (job) {
      if (!job.blocked) job.nextAttempt = 0;
    });
    self.writeQueue();
    self.flush();
    if (!self.gamePaused) {
      self.gameRetryAt = 0;
      self.scheduleGame(0);
    }
    self.refreshGame();
  });
  window.addEventListener("storage", function (event) {
    if (event.key === self.queueKey || (event.key && event.key.indexOf(self.queueKey + ".job.") === 0)) {
      self.readQueue();
      self.scheduleQueue();
    }
  });

  this.request("GET").then(function (response) {
    self.apply(response.data, response.sequence);
  }).catch(function (error) {
    if (error.sequence >= self.appliedSequence) self.reportError(error);
  });
  this.scheduleQueue();
}

ServerStorageManager.prototype.report = function (state, message) {
  this.root.dataset.storageState = state;
  this.root.dataset.storageMessage = message || "";
  this.root.dispatchEvent(new CustomEvent("tfe:storage-status", {
    detail: { state: state, message: message || "" }
  }));
};

ServerStorageManager.prototype.reportError = function (error) {
  if (this.isAuthenticationError(error.status)) {
    this.report("error", this.authenticationMessage());
    return;
  }
  if (error.status === 400) {
    this.report("error", this.verificationMessage());
    return;
  }
  if (!error.status && (this.queueDirty || !this.persistent)) {
    this.report("error", "Offline and browser storage is unavailable. Keep this page open until the game is saved.");
    return;
  }
  this.report(error.status ? "error" : "offline", error.status
    ? "Could not save the verified game: " + error.message
    : "Offline. Saved games will be submitted when the connection returns.");
};

ServerStorageManager.prototype.isAuthenticationError = function (status) {
  return status === 401 || status === 403 || status === 412;
};

ServerStorageManager.prototype.authenticationMessage = function () {
  return "Your session needs to be renewed. Sign in again or refresh this page to submit the saved game.";
};

ServerStorageManager.prototype.verificationMessage = function () {
  return "This game could not be verified. Start a new game; the result remains saved locally.";
};

ServerStorageManager.prototype.copyActions = function (actions) {
  return actions.map(function (action) { return action.slice(); });
};

ServerStorageManager.prototype.request = function (method, body, url, keepalive) {
  var sequence = ++this.requestSequence;
  var headers = {
    "requesttoken": document.head.getAttribute("data-requesttoken"),
    "Accept": "application/json"
  };
  var options = { method: method, headers: headers, credentials: "same-origin" };
  if (keepalive) options.keepalive = true;
  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return Promise.resolve().then(function () {
    return fetch(url || this.scoresUrl, options);
  }.bind(this)).then(function (response) {
    if (!response.ok) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        var error = new Error(data.message || "HTTP " + response.status);
        error.status = response.status;
        error.data = data;
        throw error;
      });
    }
    return response.json().then(function (data) {
      return { data: data, sequence: sequence };
    });
  }).catch(function (error) {
    error.sequence = sequence;
    throw error;
  });
};

ServerStorageManager.prototype.apply = function (data, sequence) {
  // A slow initial GET must not replace a newer submission's leaderboard.
  if (!data || !Array.isArray(data.leaderboard) || sequence < this.appliedSequence) return;
  this.appliedSequence = sequence;
  this.leaderboard.render(data);
  if (data.me) {
    this.submitted = Math.max(this.submitted, data.me.score);
    this.submittedTile = Math.max(this.submittedTile, data.me.bestTile || 0);
    this.best = Math.max(this.best, this.submitted);
    this.bestTile = Math.max(this.bestTile, this.submittedTile);
  }
};

ServerStorageManager.prototype.readQueue = function (startup) {
  try {
    var self = this;
    var jobs = Object.create(null);
    var prefix = this.queueKey + ".job.";
    this.storageKeys().forEach(function (key) {
      if (key.indexOf(prefix) !== 0) return;
      var raw = self.local.storage.getItem(key);
      if (!raw) return;
      try {
        var job = JSON.parse(raw);
        if (!self.validJob(job)) throw new Error("Invalid saved proof");
        job.id = key.slice(prefix.length);
        if (!self.removedProofs[job.id] && !self.acknowledgedProofs[job.id]) jobs[job.id] = job;
        self.persistedProofs[job.id] = raw;
      } catch (error) {
        self.report("error", "A saved game proof could not be read.");
      }
    });
    // Failed writes remain an overlay over storage, including when another tab
    // writes an unrelated proof. Never replace that newer in-memory game log.
    Object.keys(this.dirtyProofs).forEach(function (id) {
      if (!self.removedProofs[id] && !self.acknowledgedProofs[id]) jobs[id] = self.dirtyProofs[id];
    });

    var legacy = startup && this.local.storage.getItem(this.queueKey);
    if (legacy) {
      var oldJobs = JSON.parse(legacy);
      if (!Array.isArray(oldJobs)) throw new Error("Invalid submission queue");
      oldJobs.forEach(function (job) {
        if (!self.validJob(job)) return;
        if (!job.id || (jobs[job.id] && JSON.stringify(jobs[job.id].actions) !== JSON.stringify(job.actions))) {
          job.id = self.newJobId();
        }
        if (!jobs[job.id]) jobs[job.id] = job;
      });
    }
    this.queue = Object.keys(jobs).map(function (id) { return jobs[id]; });
    var normalized = !!legacy;
    this.queue.forEach(function (job) {
      // A new page has fresh authentication/CSRF metadata. Retry an auth pause
      // once on startup; online events on the old page cannot renew its token.
      if (startup && self.isAuthenticationError(job.failureStatus)) {
        job.blocked = false;
        job.nextAttempt = 0;
        job.attempts = 0;
        normalized = true;
      }
    });
    this.queue.forEach(function (job) {
      self.best = Math.max(self.best, job.score || 0);
      self.bestTile = Math.max(self.bestTile, job.bestTile || 0);
    });
    if (normalized && this.writeQueue() && legacy) {
      // Keep the legacy array as a backup, and stop using it only after every
      // proof has its own durable key. Concurrent migrations are idempotent.
      this.local.storage.setItem(this.queueKey + ".legacy", legacy);
      this.local.storage.removeItem(this.queueKey);
    }
  } catch (error) {
    this.report("error", "The saved submission queue could not be read.");
  }
};

ServerStorageManager.prototype.validJob = function (job) {
  return job && typeof job.session === "string" && Array.isArray(job.actions) &&
    job.actions.every(function (action) { return Array.isArray(action); });
};

ServerStorageManager.prototype.storageKeys = function () {
  var storage = this.local.storage;
  if (typeof storage.key === "function") {
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  }
  return Object.keys(storage._data || {}); // original 2048's memory fallback
};

ServerStorageManager.prototype.writeQueue = function () {
  var self = this;
  this.queue.forEach(function (job) {
    if (self.removedProofs[job.id] || self.acknowledgedProofs[job.id]) return;
    var raw = JSON.stringify(job);
    if (self.persistedProofs[job.id] === raw && !self.dirtyProofs[job.id]) return;
    try {
      self.local.storage.setItem(self.queueKey + ".job." + job.id, raw);
      self.persistedProofs[job.id] = raw;
      delete self.dirtyProofs[job.id];
    } catch (error) {
      self.dirtyProofs[job.id] = job;
    }
  });
  // A durable prefix stays until its successor is durable or acknowledged.
  // Purely in-memory prefixes can be folded into a longer in-memory proof.
  this.queue = this.queue.filter(function (job) {
    var dirtyOnly = !!self.dirtyProofs[job.id] && !self.persistedProofs[job.id];
    var covered = self.queue.some(function (newer) {
      return newer.id !== job.id && newer.session === job.session && newer.actions.length > job.actions.length &&
        (dirtyOnly || (!self.dirtyProofs[newer.id] && self.persistedProofs[newer.id] === JSON.stringify(newer))) &&
        self.isPrefix(job.actions, newer.actions);
    });
    if (covered) {
      if (dirtyOnly) delete self.dirtyProofs[job.id];
      else self.removedProofs[job.id] = true;
    }
    return !covered;
  });
  Object.keys(this.removedProofs).forEach(function (id) {
    try {
      self.local.storage.removeItem(self.queueKey + ".job." + id);
      delete self.removedProofs[id];
      delete self.dirtyProofs[id];
      delete self.persistedProofs[id];
    } catch (error) {
      // A stale durable prefix may be replayed after reload, which is safe.
    }
  });
  this.queueDirty = Object.keys(this.dirtyProofs).length > 0 || Object.keys(this.removedProofs).length > 0;
  if (this.queueDirty) {
    this.report("error", "Browser storage is full or unavailable. Keep this page open until the game is saved.");
  } else if (!this.persistent) {
    this.report("error", "Browser storage is unavailable. Keep this page open until the game is saved.");
  }
  return !this.queueDirty;
};

ServerStorageManager.prototype.validLocalGame = function (state) {
  var session = state && state.session;
  return this.validSavedState(state) && session && typeof session.token === "string" && session.token &&
    Number.isInteger(session.seed) && session.seed > 0 && session.seed <= 0xffffffff &&
    (session.version === undefined || session.version === 1 || session.version === 2 || session.version === 3) && Array.isArray(state.actions) &&
    state.actions.length <= 50000 && state.actions.every(this.validAction) &&
    (session.version !== 3 || (state.pendingBonuses === undefined &&
      (session.ancestorToken === undefined || (typeof session.ancestorToken === "string" && session.ancestorToken)) &&
      (session.previousToken === undefined || (typeof session.previousToken === "string" && session.previousToken &&
        Number.isInteger(session.cutover) && session.cutover >= 0 && session.cutover <= state.actions.length))));
};

ServerStorageManager.prototype.serverState = function (game) {
  if (!game || !game.session || (game.session.version !== 1 && game.session.version !== 2 && game.session.version !== 3) ||
      !Number.isInteger(game.revision) || game.revision < 0) throw new Error("Invalid active game response");
  var state = Object.assign({}, game.state, {
    session: game.session, actions: this.copyActions(game.actions || []), revision: game.revision
  });
  if (!this.validLocalGame(state)) throw new Error("Invalid active game state");
  return state;
};

ServerStorageManager.prototype.onGameChange = function (callback) {
  this.gameListeners.push(callback);
};

ServerStorageManager.prototype.isUpgrade = function (oldSession, newSession) {
  if (!oldSession || !newSession || newSession.seed !== oldSession.seed) return false;
  var version = oldSession.version === undefined ? 1 : oldSession.version;
  var directParent = newSession.previousToken === oldSession.token;
  return (newSession.version === 2 && version === 1 && directParent) ||
    (newSession.version === 3 && ((directParent && (version === 1 || version === 2)) ||
      (version === 1 && newSession.ancestorToken === oldSession.token)));
};

ServerStorageManager.prototype.canExtendUpgrade = function (game) {
  return game.session.version !== 3 || game.actions.length === game.session.cutover;
};

// Preserve the offline history's original rules before switching versions. A
// v3 promotion extends its signed cutover; no client board or counters are sent.
ServerStorageManager.prototype.promoteGame = function (initial, local, generation) {
  if (this.gamePromotion && this.gamePromotion.generation === generation) return this.gamePromotion.promise;
  var self = this;
  var pending = this.replayUpgrade(initial, local, generation).then(function (response) {
    if (self.gamePromotion && self.gamePromotion.promise === pending) self.gamePromotion = null;
    return response;
  }, function (error) {
    if (self.gamePromotion && self.gamePromotion.promise === pending) self.gamePromotion = null;
    throw error;
  });
  this.gamePromotion = { generation: generation, promise: pending };
  return pending;
};

ServerStorageManager.prototype.replayUpgrade = async function (initial, local, generation) {
  var target = initial;
  var oldSession = local.session;
  var actions = this.copyActions(local.actions);
  this.gameTransitioning = true;
  clearTimeout(this.gameTimer);
  this.gameTimer = null;
  try {
    for (var attempt = 0; attempt < 3; attempt++) {
      if (generation !== this.gameGeneration) return null;
      try {
        var body = { session: target.session.token, actions: actions, revision: target.revision };
        if (target.session.version === 3) body.upgradeFrom = target.session.previousToken;
        var saved = await this.request("PUT", body, this.gamesUrl);
        this.serverState(saved.data.game);
        return saved;
      } catch (error) {
        if (generation !== this.gameGeneration) return null;
        if (error.status !== 409) throw error;
        var latest = await this.request("GET", null, this.gamesUrl);
        if (generation !== this.gameGeneration) return null;
        var current = latest.data.game;
        if (current === null) {
          target = Object.assign({}, target, { revision: 0, actions: [] });
          continue;
        }
        this.serverState(current);
        var linked = current.session.token === target.session.token || this.isUpgrade(oldSession, current.session);
        if (!linked || !this.canExtendUpgrade(current) || !this.isPrefix(current.actions, actions) || current.actions.length === actions.length) return latest;
        target = current;
      }
    }
    var busy = new Error("The game changed repeatedly. Your moves remain in this browser and will be retried.");
    busy.status = 503;
    throw busy;
  } finally {
    if (generation === this.gameGeneration) this.gameTransitioning = false;
  }
};

ServerStorageManager.prototype.activateGame = function (state, savedActions, revision, canonical) {
  // This history supersedes any migration belonging to the previous one.
  // Its late finally/response is guarded by gameGeneration.
  this.gameTransitioning = false;
  this.gamePromotion = null;
  this.session = Object.assign({}, state.session, { version: state.session.version || 1 });
  this.actions = this.copyActions(state.actions);
  this.gamePeakScore = state.peakScore || state.score || 0;
  this.gameBestTile = state.maxTile || 0;
  this.gameRevision = revision;
  this.revision = revision;
  this.gameSavedActions = this.copyActions(savedActions);
  this.gameDirty = !this.isPrefix(this.actions, this.gameSavedActions) || this.actions.length !== this.gameSavedActions.length;
  this.gamePaused = false;
  this.gameRetryAt = 0;
  this.gameRetryAttempts = 0;
  this.gameConflictAttempts = 0;
  this.setGameState(state, canonical !== false);
  if (this.gameDirty) this.scheduleGame(0);
  return this.activeState;
};

ServerStorageManager.prototype.prepareGame = function (previousState) {
  var generation = ++this.gameGeneration;
  this.gameTransitioning = false;
  this.gamePromotion = null;
  this.preparingGame = true;
  clearTimeout(this.gameTimer);
  this.gameTimer = null;
  var restart = this.restartRequested;
  this.restartRequested = false;
  var local = !restart && this.validLocalGame(previousState) ? previousState : null;
  if (previousState && !local && !restart) {
    try { this.local.storage.setItem(this.local.gameStateKey + ".invalid", JSON.stringify(previousState)); }
    catch (error) { this.report("error", "The previous board is invalid and could not be backed up."); }
  }
  var self = this;
  var initial = restart
    ? this.request("POST", { restart: true }, this.gamesUrl)
    : this.request("GET", null, this.gamesUrl);
  return initial.then(function (response) {
    if (generation !== self.gameGeneration) return null;
    var game = response.data.game;
    if (game === null && local && !restart) {
      self.preparingGame = false;
      var adopted = self.activateGame(local, [], 0, false);
      self.gameDirty = true; // Adoption of an existing local session, even an empty log.
      self.gameAdopting = true;
      self.scheduleGame(0);
      return adopted;
    }
    if (game === null) return self.request("POST", { restart: false }, self.gamesUrl);
    return response;
  }).then(async function (response) {
    if (generation !== self.gameGeneration) return null;
    // The preceding branch already restored a local game for adoption.
    if (response && response.session) return response;
    var game = response && response.data.game;
    var server = self.serverState(game);
    if (!restart) {
      // The shared cache may have been written by a slower tab. Reconcile
      // independent drafts against the server before choosing the local tail.
      var anchor = self.compatibleLocalGame(server, local) ? local : server;
      var candidate = self.newerLocalGame(anchor, self.readGameDrafts(), server);
      if (candidate !== server && candidate !== local) {
        if (local && !self.compatibleLocalGame(server, local)) self.backupGame(local);
        local = candidate;
      }
    }
    if (local && self.isUpgrade(local.session, game && game.session) && self.canExtendUpgrade(game) && self.isPrefix(game.actions, local.actions) &&
        local.actions.length > game.actions.length) {
      response = await self.promoteGame(game, local, generation);
      if (generation !== self.gameGeneration) return null;
      game = response.data.game;
      server = self.serverState(game);
    }
    self.preparingGame = false;
    self.appliedGameSequence = response.sequence;
    self.gameAdopting = false;
    if (local && local.session.token === game.session.token && local.actions.length > game.actions.length && self.isPrefix(game.actions, local.actions)) {
      return self.activateGame(local, game.actions, game.revision);
    }
    if (local && (local.session.token !== game.session.token || !self.isPrefix(local.actions, game.actions))) self.backupGame(local);
    return self.activateGame(server, game.actions, game.revision);
  }).catch(function (error) {
    if (generation !== self.gameGeneration) return null;
    self.preparingGame = false;
    if (local && (!error.status || error.status >= 500 || self.isAuthenticationError(error.status))) {
      var restored = self.activateGame(local, [], Number.isInteger(local.revision) ? local.revision : 0, false);
      self.gameDirty = true;
      self.gamePaused = self.isAuthenticationError(error.status);
      self.gameRetryAt = Date.now() + 1000;
      self.scheduleGame(1000);
      self.reportError(error);
      return restored;
    }
    self.session = null;
    self.actions = [];
    self.reportError(error);
    throw error;
  });
};

ServerStorageManager.prototype.startNewGame = function () {
  ++this.gameGeneration;
  this.restartRequested = true;
  this.gameTransitioning = false;
  this.gamePromotion = null;
  this.gameDirty = false;
  this.activeState = null;
  this.gameInFlight = null;
  this.gameRefreshInFlight = null;
  clearTimeout(this.gameTimer);
  this.gameTimer = null;
  try { this.local.clearGameState(); }
  catch (error) { this.report("error", "The previous board could not be removed from browser storage."); }
  return this.flush();
};

ServerStorageManager.prototype.scheduleGame = function (delay) {
  if (!this.session || !this.gameDirty || this.gamePaused || this.preparingGame || this.restartRequested || this.gameTransitioning) return;
  var due = Math.max(Date.now() + delay, this.gameRetryAt);
  if (this.gameTimer !== null && this.gameTimerDue <= due) return;
  clearTimeout(this.gameTimer);
  this.gameTimerDue = due;
  var self = this;
  this.gameTimer = setTimeout(function () { self.flushGame(); }, Math.max(0, due - Date.now()));
};

ServerStorageManager.prototype.receiveGame = async function (game, sequence, notify) {
  if (sequence < this.appliedGameSequence) return;
  if (!game) {
    this.appliedGameSequence = sequence;
    this.gameRevision = 0;
    this.revision = 0;
    this.gameSavedActions = [];
    this.gameDirty = true;
    this.gameAdopting = true;
    this.scheduleGame(0);
    return;
  }
  var state = this.serverState(game);
  var generation = this.gameGeneration;
  if (this.isUpgrade(this.session, game.session) && this.canExtendUpgrade(game) && this.isPrefix(game.actions, this.actions) && this.actions.length > game.actions.length) {
    var local = Object.assign({}, this.activeState, { session: this.session, actions: this.copyActions(this.actions) });
    var promoted = await this.promoteGame(game, local, generation);
    if (generation !== this.gameGeneration) return;
    game = promoted.data.game;
    sequence = promoted.sequence;
    state = this.serverState(game);
  }
  if (this.session && game.session.token === this.session.token && game.revision < this.gameRevision) return;
  this.appliedGameSequence = sequence;
  if (this.session && game.session.token === this.session.token && this.isPrefix(game.actions, this.actions) &&
      (game.actions.length < this.actions.length || this.sameGameState(this.activeState, state))) {
    this.gameRevision = game.revision;
    this.revision = game.revision;
    this.gameSavedActions = this.copyActions(game.actions);
    this.gameDirty = game.actions.length < this.actions.length;
    this.gameAdopting = false;
    if (this.activeState) this.setGameState(this.activeState);
    if (this.gameDirty) this.scheduleGame(0);
    return;
  }
  var sameParty = this.session && (game.session.token === this.session.token || this.isUpgrade(this.session, game.session));
  var conflict = this.session && (!sameParty || !this.isPrefix(this.actions, game.actions));
  var remoteSpending = sameParty && game.actions.length > this.actions.length && this.isPrefix(this.actions, game.actions) &&
    this.activeState && ["undo", "swap", "remove"].some(function (type) {
      return state.bonuses[type] < this.activeState.bonuses[type];
    }, this);
  if (conflict && this.activeState) this.backupGame(this.activeState);
  ++this.gameGeneration; // Responses for the replaced local history are obsolete.
  this.activateGame(state, game.actions, game.revision);
  if (notify) {
    var message = conflict ? "The game changed in another browser. Its latest position has been loaded."
      : remoteSpending ? "The game advanced in another browser. Its latest position has been loaded." : "";
    this.gameListeners.forEach(function (callback) { callback(state, message); });
  }
};

ServerStorageManager.prototype.sameGameState = function (left, right) {
  if (!left || !right) return false;
  return ["grid", "score", "over", "won", "keepPlaying", "moves", "maxTile", "bonuses", "pendingBonuses", "reached", "previous", "randomState"].every(function (key) {
    return JSON.stringify(left[key]) === JSON.stringify(right[key]);
  });
};

ServerStorageManager.prototype.refreshGame = function () {
  if (!this.session || this.preparingGame || this.restartRequested || this.gameTransitioning || this.gameInFlight || this.gameRefreshInFlight) {
    return Promise.resolve(false);
  }
  var generation = this.gameGeneration;
  var self = this;
  var pending = this.request("GET", null, this.gamesUrl).then(async function (response) {
    if (generation === self.gameGeneration) await self.receiveGame(response.data.game, response.sequence, true);
    return true;
  }).catch(function (error) {
    if (generation === self.gameGeneration) {
      if (self.gameDirty) self.failGameSave(error);
      else self.reportError(error);
    }
    return false;
  }).then(function (result) {
    if (self.gameRefreshInFlight === pending) self.gameRefreshInFlight = null;
    return result;
  });
  this.gameRefreshInFlight = pending;
  return pending;
};

ServerStorageManager.prototype.flushGame = function (keepalive) {
  clearTimeout(this.gameTimer);
  this.gameTimer = null;
  this.gameTimerDue = 0;
  if (this.gameInFlight) return this.gameInFlight;
  if (!this.session || !this.gameDirty || this.gamePaused || this.preparingGame || this.restartRequested || this.gameTransitioning) return Promise.resolve(false);
  if (this.gameRetryAt > Date.now()) { this.scheduleGame(this.gameRetryAt - Date.now()); return Promise.resolve(false); }
  var token = this.session.token;
  var generation = this.gameGeneration;
  var actions = this.copyActions(this.actions);
  var self = this;
  var pending = this.request("PUT", { session: token, actions: actions, revision: this.gameRevision }, this.gamesUrl, keepalive)
    .then(async function (response) {
      if (generation === self.gameGeneration) {
        self.gameRetryAttempts = 0;
        self.gameRetryAt = 0;
        self.gameConflictAttempts = 0;
        await self.receiveGame(response.data.game, response.sequence, true);
      }
      return true;
    }).catch(function (error) {
      if (generation !== self.gameGeneration) return false;
      if (error.status === 409) {
        self.gameConflictAttempts++;
        return self.request("GET", null, self.gamesUrl).then(async function (response) {
          if (generation === self.gameGeneration) {
            await self.receiveGame(response.data.game, response.sequence, true);
            if (generation === self.gameGeneration && self.gameDirty && self.gameConflictAttempts >= 2) {
              self.gameRetryAt = Date.now() + Math.min(60000, 1000 * Math.pow(2, Math.min(self.gameConflictAttempts - 2, 6)));
              clearTimeout(self.gameTimer);
              self.gameTimer = null;
            }
          }
          return false;
        }).catch(function (refreshError) { if (generation === self.gameGeneration) self.failGameSave(refreshError); return false; });
      }
      if (error.status === 400 && self.gameAdopting) {
        if (self.activeState) self.backupGame(self.activeState);
        return self.request("POST", { restart: false }, self.gamesUrl).then(async function (response) {
          if (generation === self.gameGeneration) {
            self.gameAdopting = false;
            await self.receiveGame(response.data.game, response.sequence, true);
          }
          return false;
        }).catch(function (ensureError) { if (generation === self.gameGeneration) self.failGameSave(ensureError); return false; });
      }
      self.failGameSave(error);
      return false;
    }).then(function (result) {
      if (self.gameInFlight === pending) self.gameInFlight = null;
      if (self.gameDirty) self.scheduleGame(0);
      return result;
    });
  this.gameInFlight = pending;
  return pending;
};

ServerStorageManager.prototype.failGameSave = function (error) {
  this.gameRetryAttempts++;
  this.gameRetryAt = Date.now() + Math.min(60000, 1000 * Math.pow(2, Math.min(this.gameRetryAttempts - 1, 6)));
  this.gamePaused = !!error.status && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
  this.reportError(error);
};

ServerStorageManager.prototype.backupGame = function (state) {
  try { this.local.storage.setItem(this.local.gameStateKey + ".superseded", JSON.stringify(state)); }
  catch (error) { this.report("error", "The previous game could not be backed up in browser storage."); }
};

ServerStorageManager.prototype.validAction = function (action) {
  if (!Array.isArray(action)) return false;
  if (action[0] === "move") return action.length === 2 && Number.isInteger(action[1]) && action[1] >= 0 && action[1] <= 3;
  if (action[0] === "undo" || action[0] === "continue") return action.length === 1;
  if (action[0] === "swap") return action.length === 5 && action.slice(1).every(function (value) {
    return Number.isInteger(value) && value >= 0 && value <= 3;
  });
  if (action[0] === "remove") return action.length === 2 && Number.isInteger(action[1]) &&
    action[1] >= 2 && action[1] <= 131072 && (action[1] & (action[1] - 1)) === 0;
  return false;
};

ServerStorageManager.prototype.validSavedState = function (state) {
  if (!state || !Number.isInteger(state.randomState) || state.randomState <= 0 || state.randomState > 0xffffffff ||
      !this.validBoard(state)) return false;
  if (!state.bonuses || !["undo", "swap", "remove"].every(function (type) {
    return Number.isInteger(state.bonuses[type]) && state.bonuses[type] >= 0 && state.bonuses[type] <= 2;
  })) return false;
  if (state.pendingBonuses !== undefined && (!state.pendingBonuses || !["undo", "swap", "remove"].every(function (type) {
    return Number.isInteger(state.pendingBonuses[type]) && state.pendingBonuses[type] >= 0 && state.pendingBonuses[type] <= 1;
  }))) return false;
  return !state.previous || this.validBoard(state.previous);
};

ServerStorageManager.prototype.validBoard = function (state) {
  if (!state || !state.grid || state.grid.size !== 4 || !Array.isArray(state.grid.cells) || state.grid.cells.length !== 4 ||
      !Number.isInteger(state.score) || state.score < 0 || state.score > 4000000 ||
      !Number.isInteger(state.moves) || state.moves < 0 || state.moves > 1000000 ||
      typeof state.won !== "boolean" || typeof state.over !== "boolean") return false;
  return state.grid.cells.every(function (column, x) {
    return Array.isArray(column) && column.length === 4 && column.every(function (tile, y) {
      return tile === null || (tile && tile.position && tile.position.x === x && tile.position.y === y &&
        Number.isInteger(tile.value) && tile.value >= 2 && tile.value <= 131072 && (tile.value & (tile.value - 1)) === 0);
    });
  });
};

ServerStorageManager.prototype.recordAction = function (action) {
  if (!this.session) throw new Error("A server-issued game session is required");
  if (this.gameTransitioning) throw new Error("Game rules are being updated. Try again shortly.");
  this.actions.push(action.slice());
  this.gameDirty = true;
  this.scheduleGame(1000);
};

ServerStorageManager.prototype.getBestScore = function () {
  return this.best;
};

ServerStorageManager.prototype.updateScore = function (score, stats) {
  this.gamePeakScore = Math.max(this.gamePeakScore, score);
  this.gameBestTile = Math.max(this.gameBestTile, stats ? stats.bestTile : 0);
  this.best = Math.max(this.best, this.gamePeakScore);
  this.bestTile = Math.max(this.bestTile, this.gameBestTile);
  if (!this.session) return;

  this.readQueue();
  var token = this.session.token;
  var self = this;
  var job = this.queue.find(function (candidate) {
    return candidate.session === token &&
      (self.isPrefix(candidate.actions, self.actions) || self.isPrefix(self.actions, candidate.actions));
  });
  if (!job && this.gamePeakScore <= this.submitted && this.gameBestTile <= this.submittedTile) return;

  if (!job || job.actions.length < this.actions.length) {
    var previous = job;
    job = {
      id: this.newJobId(), session: token, actions: this.copyActions(this.actions),
      score: previous ? previous.score : 0,
      bestTile: previous ? previous.bestTile : 0,
      attempts: previous ? previous.attempts : 0,
      nextAttempt: previous ? previous.nextAttempt : 0,
      blocked: previous ? previous.blocked : false,
      failureStatus: previous ? previous.failureStatus : 0,
      error: previous ? previous.error : ""
    };
    this.queue.push(job);
  }
  // A board can be older than its queued proof after a storage failure. Preserve
  // the longer proof; a subsequently diverging play-through becomes another job.
  job.score = Math.max(job.score || 0, this.gamePeakScore);
  job.bestTile = Math.max(job.bestTile || 0, this.gameBestTile);
  this.writeQueue();
  this.schedule(1500);
};

ServerStorageManager.prototype.isPrefix = function (prefix, actions) {
  return prefix.length <= actions.length && prefix.every(function (action, index) {
    return JSON.stringify(action) === JSON.stringify(actions[index]);
  });
};

ServerStorageManager.prototype.newJobId = function () {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return Date.now().toString(36) + "." + Math.random().toString(36).slice(2) + "." + (++this.jobCounter);
};

// Compatibility with callers of the original 2048 storage API.
ServerStorageManager.prototype.setBestScore = function (score, stats) {
  this.updateScore(score, stats);
};

ServerStorageManager.prototype.schedule = function (delay) {
  var due = Date.now() + delay;
  if (this.timer !== null && this.timerDue <= due) return;
  clearTimeout(this.timer);
  this.timerDue = due;
  var self = this;
  this.timer = setTimeout(function () { self.flush(); }, delay);
};

ServerStorageManager.prototype.scheduleQueue = function () {
  var maximal = this.maximalQueue();
  var available = maximal.filter(function (job) { return !job.blocked; });
  if (available.length) {
    var due = Math.min.apply(null, available.map(function (job) { return job.nextAttempt || 0; }));
    this.schedule(Math.max(0, due - Date.now()));
  } else if (maximal.length) {
    this.report("error", maximal[0].error || "A game could not be verified and remains saved locally.");
  }
};

ServerStorageManager.prototype.maximalQueue = function () {
  var self = this;
  return this.queue.filter(function (job) {
    return !self.queue.some(function (newer) {
      return newer.id !== job.id && newer.session === job.session && newer.actions.length > job.actions.length &&
        (!newer.blocked || self.isAuthenticationError(newer.failureStatus)) && self.isPrefix(job.actions, newer.actions);
    });
  });
};

ServerStorageManager.prototype.flush = function (keepalive) {
  clearTimeout(this.timer);
  this.timer = null;
  this.timerDue = 0;
  if (this.inFlight) return this.inFlight;
  this.readQueue();
  var now = Date.now();
  var job = this.maximalQueue().find(function (candidate) {
    return !candidate.blocked && (!candidate.nextAttempt || candidate.nextAttempt <= now);
  });
  if (!job) {
    this.scheduleQueue();
    return Promise.resolve(false);
  }

  var token = job.session;
  var id = job.id;
  var actions = this.copyActions(job.actions);
  var self = this;
  this.report("syncing", "");
  this.inFlight = this.request("POST", { session: token, actions: actions }, this.scoresUrl, keepalive)
    .then(function (response) {
      if (!response.data || !Array.isArray(response.data.leaderboard) || !response.data.me ||
          !Number.isInteger(response.data.me.score) || response.data.me.score < 0 ||
          !Number.isInteger(response.data.me.bestTile) || response.data.me.bestTile < 0) {
        var error = new Error("Invalid leaderboard response");
        error.status = 502;
        throw error;
      }
      self.readQueue();
      // Accepted replay covers every known prefix of this frozen history.
      // Newer tails and diverging histories still need their own submission.
      self.queue = self.queue.filter(function (candidate) {
        if (candidate.session === token && self.isPrefix(candidate.actions, actions)) {
          self.removedProofs[candidate.id] = true;
          self.acknowledgedProofs[candidate.id] = true;
          return false;
        }
        return true;
      });
      // This prefix might already have been compacted into a newer proof.
      self.removedProofs[id] = true;
      self.acknowledgedProofs[id] = true;
      self.writeQueue();
      self.apply(response.data, response.sequence);
      if (!self.queue.length) self.report("saved", "");
      return true;
    }).catch(function (error) {
      self.readQueue();
      var failedJobs = self.queue.filter(function (candidate) {
        return candidate.session === token && (candidate.id === id || self.isPrefix(actions, candidate.actions));
      });
      failedJobs.forEach(function (failed) {
        failed.attempts = (failed.attempts || 0) + 1;
        failed.nextAttempt = Date.now() + Math.min(60000, 1000 * Math.pow(2, Math.min(failed.attempts - 1, 6)));
        failed.blocked = !!error.status && error.status >= 400 && error.status < 500 &&
          error.status !== 408 && error.status !== 429;
        failed.failureStatus = error.status || 0;
        failed.error = self.isAuthenticationError(error.status) ? self.authenticationMessage()
          : error.status === 400 ? self.verificationMessage() : error.message;
      });
      self.writeQueue();
      self.reportError(error);
      return false;
    }).then(function (result) {
      self.inFlight = null;
      self.scheduleQueue();
      return result;
    });
  return this.inFlight;
};

ServerStorageManager.prototype.getGameState = function () {
  if (this.restartRequested) return null;
  var local = null;
  var current = null;
  try {
    current = this.local.storage.getItem(this.currentGameKey);
    local = this.local.getGameState();
    if (local && !this.validLocalGame(local)) throw new Error("Invalid saved board");
  } catch (error) {
    local = null;
    try {
      var raw = this.local.storage.getItem(this.local.gameStateKey);
      if (raw) this.local.storage.setItem(this.local.gameStateKey + ".invalid", raw);
    } catch (backupError) {
      // The pending submission queue is independent and must stay untouched.
    }
    this.report("error", "The saved board could not be restored. Your pending scores are kept separately.");
  }
  var drafts = this.readGameDrafts();
  if (current && local && local.session.token !== current) local = null;
  if (!local) {
    var candidates = current ? drafts.filter(function (draft) { return draft.state.session.token === current; }) : drafts;
    if (candidates.length) {
      local = candidates.reduce(function (latest, draft) {
        return draft.savedAt > latest.savedAt ? draft : latest;
      }).state;
    }
  }
  return local ? this.newerLocalGame(local, drafts) : null;
};

ServerStorageManager.prototype.readGameDrafts = function () {
  var drafts = [];
  var self = this;
  try {
    this.storageKeys().forEach(function (key) {
      if (key.indexOf(self.draftKey) !== 0) return;
      try {
        var raw = self.local.storage.getItem(key);
        if (!raw) return; // A concurrent tab may already have compacted it.
        var draft = JSON.parse(raw);
        if (!draft || !Number.isInteger(draft.savedAt) || !self.validLocalGame(draft.state)) throw new Error("Invalid saved draft");
        drafts.push({ key: key, state: draft.state, savedAt: draft.savedAt });
      } catch (error) {
        self.report("error", "A saved board draft could not be read.");
      }
    });
  } catch (error) {
    this.report("error", "The saved board drafts could not be read.");
  }
  return drafts;
};

ServerStorageManager.prototype.compatibleLocalGame = function (server, local) {
  return this.validLocalGame(local) &&
    (server.session.token === local.session.token ||
      (this.isUpgrade(local.session, server.session) && this.canExtendUpgrade(server))) &&
    this.isPrefix(server.actions, local.actions);
};

ServerStorageManager.prototype.newerLocalGame = function (reference, drafts, canonical) {
  var self = this;
  return drafts.reduce(function (latest, draft) {
    return self.compatibleLocalGame(canonical || reference, draft.state) && self.isPrefix(reference.actions, draft.state.actions) &&
      draft.state.actions.length > latest.actions.length
      ? draft.state : latest;
  }, reference);
};

ServerStorageManager.prototype.persistGameState = function (saved, canonical) {
  var drafts = this.readGameDrafts();
  var self = this;
  var cached;
  try { cached = this.local.getGameState(); } catch (error) { cached = null; }
  var covering = this.validLocalGame(cached) && cached.session.token === saved.session.token &&
    cached.actions.length > saved.actions.length && this.isPrefix(saved.actions, cached.actions) ? cached : saved;
  var existing = drafts.reduce(function (best, draft) {
    if (draft.state.session.token !== covering.session.token || !self.isPrefix(covering.actions, draft.state.actions) ||
        (draft.state.actions.length === covering.actions.length && !self.sameGameState(covering, draft.state))) return best;
    return !best || draft.state.actions.length > best.state.actions.length ? draft : best;
  }, null);
  if (existing) covering = existing.state;
  else {
    // Each key is immutable. Another tab can compact this frozen prefix,
    // but cannot delete a mutable slot just as its owner extends it. Keep an
    // immutable checkpoint after ACK too: the shared cache can still race.
    this.local.storage.setItem(this.draftKey + this.newJobId(), JSON.stringify({ state: covering, savedAt: Date.now() }));
  }

  // Ordinary moves and late ACKs cannot select an older party, even if their
  // cache write races with another tab's successful New Game.
  if (canonical) this.local.storage.setItem(this.currentGameKey, saved.session.token);
  if (!this.validLocalGame(cached) || cached.session.token === saved.session.token || canonical) {
    // This is a compatibility cache, not the only durable copy. Preserve a
    // longer compatible tail even when a shorter request is acknowledged.
    var next = this.validLocalGame(cached) && cached.session.token === saved.session.token &&
      cached.actions.length > saved.actions.length && this.isPrefix(saved.actions, cached.actions)
      ? Object.assign({}, cached, { revision: Math.max(cached.revision || 0, saved.revision) }) : saved;
    this.local.setGameState(next);
  }

  // A covering immutable checkpoint is durable, including after a server ACK.
  // Never remove longer tails, other parties, or diverging histories.
  drafts.forEach(function (draft) {
    if (draft.state === covering || draft.state.session.token !== covering.session.token ||
        !self.isPrefix(draft.state.actions, covering.actions)) return;
    try { self.local.storage.removeItem(draft.key); } catch (error) { /* Safe redundant prefix. */ }
  });
};

ServerStorageManager.prototype.setGameState = function (gameState, canonical) {
  var saved = Object.assign({}, gameState, {
    session: this.session,
    actions: this.copyActions(this.actions),
    peakScore: this.gamePeakScore,
    revision: this.gameRevision
  });
  this.activeState = saved;
  try {
    this.persistGameState(saved, canonical);
    if (!this.persistent) this.report("error", "Browser storage is unavailable. This board will not survive a reload.");
  } catch (error) {
    this.report("error", "Browser storage is full or unavailable. Keep this page open until the game is saved.");
  }
  if (this.gameDirty) this.scheduleGame(1000);
};

ServerStorageManager.prototype.clearGameState = function () {
  this.flushGame(); // Terminal games remain resumable; only startNewGame replaces them.
  return this.flush();
};

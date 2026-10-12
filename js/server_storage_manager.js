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
  this.queueKey = "twentyfortyeight.submissions." + identity;
  this.readQueue(true);

  var self = this;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") self.flush(true);
  });
  window.addEventListener("pagehide", function () { self.flush(true); });
  window.addEventListener("online", function () {
    self.readQueue();
    self.queue.forEach(function (job) {
      if (!job.blocked) job.nextAttempt = 0;
    });
    self.writeQueue();
    self.flush();
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

ServerStorageManager.prototype.prepareGame = function (previousState) {
  var session = previousState && previousState.session;
  if (this.validSavedState(previousState) && session && typeof session.token === "string" && session.token &&
      Number.isInteger(session.seed) && session.seed > 0 && session.seed <= 0xffffffff &&
      (session.version === undefined || session.version === 1) &&
      Array.isArray(previousState.actions) && previousState.actions.length <= 50000 &&
      previousState.actions.every(this.validAction)) {
    this.session = { token: session.token, seed: session.seed, version: 1 };
    this.actions = this.copyActions(previousState.actions);
    this.gamePeakScore = previousState.peakScore || previousState.score || 0;
    this.gameBestTile = previousState.maxTile || 0;
    return Promise.resolve(previousState);
  }

  if (previousState) {
    try {
      this.local.storage.setItem(this.local.gameStateKey + ".invalid", JSON.stringify(previousState));
    } catch (error) {
      this.report("error", "The previous board is invalid and could not be backed up.");
    }
  }

  var self = this;
  return this.request("POST", {}, this.gamesUrl).then(function (response) {
    var data = response.data;
    if (!data || typeof data.token !== "string" || !data.token || data.version !== 1 ||
        !Number.isInteger(data.seed) || data.seed <= 0 || data.seed > 0xffffffff) {
      var error = new Error("The server returned an invalid game session");
      error.status = 502;
      throw error;
    }
    self.session = { token: data.token, seed: data.seed, version: data.version };
    self.actions = [];
    self.gamePeakScore = 0;
    self.gameBestTile = 0;
    return null;
  }).catch(function (error) {
    self.session = null;
    self.actions = [];
    self.reportError(error);
    throw error; // The game must wait for a server-issued session.
  });
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
  this.actions.push(action.slice());
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
  this.report("syncing", "Saving the verified game…");
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
      if (!self.queue.length) self.report("saved", "Result saved.");
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
  try {
    return this.local.getGameState();
  } catch (error) {
    try {
      var raw = this.local.storage.getItem(this.local.gameStateKey);
      if (raw) this.local.storage.setItem(this.local.gameStateKey + ".invalid", raw);
    } catch (backupError) {
      // The pending submission queue is independent and must stay untouched.
    }
    this.report("error", "The saved board could not be restored. Your pending scores are kept separately.");
    return null;
  }
};

ServerStorageManager.prototype.setGameState = function (gameState) {
  var saved = Object.assign({}, gameState, {
    session: this.session,
    actions: this.copyActions(this.actions),
    peakScore: this.gamePeakScore
  });
  try {
    this.local.setGameState(saved);
    if (!this.persistent) this.report("error", "Browser storage is unavailable. This board will not survive a reload.");
  } catch (error) {
    this.report("error", "Browser storage is full or unavailable. Keep this page open until the game is saved.");
  }
};

ServerStorageManager.prototype.clearGameState = function () {
  try {
    this.local.clearGameState();
  } catch (error) {
    this.report("error", "The previous board could not be removed from browser storage.");
  }
  return this.flush();
};

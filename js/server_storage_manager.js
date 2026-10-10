// Nextcloud adaptation: the best score lives on the server (shared leaderboard),
// everything else (the running game) still goes to the browser's localStorage.
function ServerStorageManager() {
  var root = document.getElementById("tfe");

  this.local      = new LocalStorageManager();
  this.scoresUrl  = root.dataset.scoresUrl;
  this.best       = parseInt(root.dataset.best, 10) || 0;
  this.pending    = null;
  this.timer      = null;
  this.submitted  = this.best;
  this.leaderboard = new Leaderboard(document.getElementById("tfe-list"),
                                     document.getElementById("tfe-me"),
                                     document.getElementById("tfe-empty"));

  // Several users can share one browser, so don't share their unfinished games.
  this.local.gameStateKey = "twentyfortyeight.gameState." + root.dataset.user;

  var self = this;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") self.flush();
  });

  this.request("GET").then(function (data) { self.apply(data); });
}

ServerStorageManager.prototype.request = function (method, body) {
  var headers = {
    "requesttoken": document.head.getAttribute("data-requesttoken"),
    "Accept": "application/json"
  };
  var options = { method: method, headers: headers, credentials: "same-origin" };

  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  return fetch(this.scoresUrl, options).then(function (response) {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }).catch(function () {
    return null; // offline etc.: the score is sent with a later move instead
  });
};

ServerStorageManager.prototype.apply = function (data) {
  if (!data) return;
  this.leaderboard.render(data);
  if (data.me) {
    this.submitted = Math.max(this.submitted, data.me.score);
    this.best      = Math.max(this.best, data.me.score);
  }
};

// Best score
ServerStorageManager.prototype.getBestScore = function () {
  return this.best;
};

ServerStorageManager.prototype.setBestScore = function (score, stats) {
  this.best = score;
  this.pending = {
    score:    score,
    bestTile: stats ? stats.bestTile : 0,
    moves:    stats ? stats.moves : 0
  };

  // Debounced, so that a fast player doesn't send a request on every move
  if (!this.timer) {
    var self = this;
    this.timer = setTimeout(function () { self.flush(); }, 1500);
  }
};

ServerStorageManager.prototype.flush = function () {
  clearTimeout(this.timer);
  this.timer = null;

  var pending = this.pending;
  if (!pending || pending.score <= this.submitted) return;
  this.pending = null;

  var self = this;
  this.request("POST", pending).then(function (data) {
    if (data) {
      self.submitted = Math.max(self.submitted, pending.score);
      self.apply(data);
    }
  });
};

// Game state: the original localStorage implementation
ServerStorageManager.prototype.getGameState = function () {
  return this.local.getGameState();
};

ServerStorageManager.prototype.setGameState = function (gameState) {
  this.local.setGameState(gameState);
};

// Called on restart and when the game is over: a good moment to send the score
ServerStorageManager.prototype.clearGameState = function () {
  this.local.clearGameState();
  this.flush();
};

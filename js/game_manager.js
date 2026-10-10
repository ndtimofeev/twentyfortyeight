// Nextcloud adaptation: bonus actions. Each one starts with BONUS_START charges
// (never more than BONUS_MAX) and gets one more the first time the matching
// tile is made in a game.
var BONUS_START      = 2;
var BONUS_MAX        = 2;
var BONUS_MILESTONES = { 128: "undo", 256: "swap", 512: "remove" };

function GameManager(size, InputManager, Actuator, StorageManager) {
  this.size           = size; // Size of the grid
  this.inputManager   = new InputManager;
  this.storageManager = new StorageManager;
  this.actuator       = new Actuator;

  this.bonusUI        = new BonusUI(this);

  this.startTiles     = 2;

  this.inputManager.on("move", this.move.bind(this));
  this.inputManager.on("restart", this.restart.bind(this));
  this.inputManager.on("keepPlaying", this.keepPlaying.bind(this));
  this.inputManager.on("tap", this.bonusUI.tap.bind(this.bonusUI));

  this.setup();
}

// Restart the game
GameManager.prototype.restart = function () {
  this.storageManager.clearGameState();
  this.actuator.continueGame(); // Clear the game won/lost message
  this.setup();
};

// Keep playing after winning (allows going over 2048)
GameManager.prototype.keepPlaying = function () {
  this.keepPlaying = true;
  this.actuator.continueGame(); // Clear the game won/lost message
  this.bonusUI.update();        // swap and remove work again
};

// Return true if the game is lost, or has won and the user hasn't kept playing
GameManager.prototype.isGameTerminated = function () {
  return this.over || (this.won && !this.keepPlaying);
};

// Set up the game
GameManager.prototype.setup = function () {
  var previousState = this.storageManager.getGameState();

  // Reload the game from a previous game if present
  if (previousState) {
    this.grid        = new Grid(previousState.grid.size,
                                previousState.grid.cells); // Reload grid
    this.score       = previousState.score;
    this.over        = previousState.over;
    this.won         = previousState.won;
    this.keepPlaying = previousState.keepPlaying;
    this.moves       = previousState.moves || 0;
    this.maxTile     = previousState.maxTile || 0;
    this.bonuses     = previousState.bonuses || this.freshBonuses();
    this.reached     = previousState.reached || {};
    this.previous    = previousState.previous || null;
  } else {
    this.grid        = new Grid(this.size);
    this.score       = 0;
    this.over        = false;
    this.won         = false;
    this.keepPlaying = false;
    this.moves       = 0;
    this.maxTile     = 0;
    this.bonuses     = this.freshBonuses();
    this.reached     = {};
    this.previous    = null; // state before the last move, used by undo

    // Add the initial tiles
    this.addStartTiles();
  }

  // Update the actuator
  this.actuate();
};

// Set up the initial tiles to start the game with
GameManager.prototype.addStartTiles = function () {
  for (var i = 0; i < this.startTiles; i++) {
    this.addRandomTile();
  }
};

// Adds a tile in a random position
GameManager.prototype.addRandomTile = function () {
  if (this.grid.cellsAvailable()) {
    var value = Math.random() < 0.9 ? 2 : 4;
    var tile = new Tile(this.grid.randomAvailableCell(), value);

    this.grid.insertTile(tile);
  }
};

// Sends the updated grid to the actuator
GameManager.prototype.actuate = function () {
  var stats = this.stats(); // also remembers the biggest tile of the game

  if (this.storageManager.getBestScore() < this.score) {
    this.storageManager.setBestScore(this.score, stats);
  }

  // Clear the state when the game is over (game over only, not win), unless the
  // last move can still be undone: then a reload must not lose that chance.
  if (this.over && !this.canUndo()) {
    this.storageManager.clearGameState();
  } else {
    this.storageManager.setGameState(this.serialize());
  }

  this.actuator.actuate(this.grid, {
    score:      this.score,
    over:       this.over,
    won:        this.won,
    bestScore:  this.storageManager.getBestScore(),
    terminated: this.isGameTerminated()
  });

  this.bonusUI.update();

};

// Represent the current game as an object
GameManager.prototype.serialize = function () {
  return {
    grid:        this.grid.serialize(),
    score:       this.score,
    over:        this.over,
    won:         this.won,
    keepPlaying: this.keepPlaying,
    moves:       this.moves,
    maxTile:     this.maxTile,
    bonuses:     this.bonuses,
    reached:     this.reached,
    previous:    this.previous
  };
};

// Extra numbers sent to the leaderboard together with the score
GameManager.prototype.stats = function () {
  var bestTile = this.maxTile;

  this.grid.eachCell(function (x, y, tile) {
    if (tile && tile.value > bestTile) bestTile = tile.value;
  });

  // Remembered, because Remove can take the biggest tile off the board
  this.maxTile = bestTile;

  return { bestTile: bestTile, moves: this.moves };
};

// Save all tile positions and remove merger info
GameManager.prototype.prepareTiles = function () {
  this.grid.eachCell(function (x, y, tile) {
    if (tile) {
      tile.mergedFrom = null;
      tile.savePosition();
    }
  });
};

// Move a tile and its representation
GameManager.prototype.moveTile = function (tile, cell) {
  this.grid.cells[tile.x][tile.y] = null;
  this.grid.cells[cell.x][cell.y] = tile;
  tile.updatePosition(cell);
};

// Move tiles on the grid in the specified direction
GameManager.prototype.move = function (direction) {
  // 0: up, 1: right, 2: down, 3: left
  var self = this;

  if (this.isGameTerminated()) return; // Don't do anything if the game's over

  var cell, tile;

  var vector     = this.getVector(direction);
  var traversals = this.buildTraversals(vector);
  var moved      = false;
  var snapshot   = this.snapshot();

  // Save the current tile positions and remove merger information
  this.prepareTiles();

  // Traverse the grid in the right direction and move tiles
  traversals.x.forEach(function (x) {
    traversals.y.forEach(function (y) {
      cell = { x: x, y: y };
      tile = self.grid.cellContent(cell);

      if (tile) {
        var positions = self.findFarthestPosition(cell, vector);
        var next      = self.grid.cellContent(positions.next);

        // Only one merger per row traversal?
        if (next && next.value === tile.value && !next.mergedFrom) {
          var merged = new Tile(positions.next, tile.value * 2);
          merged.mergedFrom = [tile, next];

          self.grid.insertTile(merged);
          self.grid.removeTile(tile);

          // Converge the two tiles' positions
          tile.updatePosition(positions.next);

          // Update the score
          self.score += merged.value;

          // The mighty 2048 tile
          if (merged.value === 2048) self.won = true;

          self.awardBonus(merged.value);
        } else {
          self.moveTile(tile, positions.farthest);
        }

        if (!self.positionsEqual(cell, tile)) {
          moved = true; // The tile moved from its original cell!
        }
      }
    });
  });

  if (moved) {
    this.previous = snapshot;
    this.moves++;
    this.addRandomTile();

    if (!this.movesAvailable()) {
      this.over = true; // Game over!
    }

    this.actuate();
  }
};

// Get the vector representing the chosen direction
GameManager.prototype.getVector = function (direction) {
  // Vectors representing tile movement
  var map = {
    0: { x: 0,  y: -1 }, // Up
    1: { x: 1,  y: 0 },  // Right
    2: { x: 0,  y: 1 },  // Down
    3: { x: -1, y: 0 }   // Left
  };

  return map[direction];
};

// Build a list of positions to traverse in the right order
GameManager.prototype.buildTraversals = function (vector) {
  var traversals = { x: [], y: [] };

  for (var pos = 0; pos < this.size; pos++) {
    traversals.x.push(pos);
    traversals.y.push(pos);
  }

  // Always traverse from the farthest cell in the chosen direction
  if (vector.x === 1) traversals.x = traversals.x.reverse();
  if (vector.y === 1) traversals.y = traversals.y.reverse();

  return traversals;
};

GameManager.prototype.findFarthestPosition = function (cell, vector) {
  var previous;

  // Progress towards the vector direction until an obstacle is found
  do {
    previous = cell;
    cell     = { x: previous.x + vector.x, y: previous.y + vector.y };
  } while (this.grid.withinBounds(cell) &&
           this.grid.cellAvailable(cell));

  return {
    farthest: previous,
    next: cell // Used to check if a merge is required
  };
};

GameManager.prototype.movesAvailable = function () {
  return this.grid.cellsAvailable() || this.tileMatchesAvailable();
};

// Check for available matches between tiles (more expensive check)
GameManager.prototype.tileMatchesAvailable = function () {
  var self = this;

  var tile;

  for (var x = 0; x < this.size; x++) {
    for (var y = 0; y < this.size; y++) {
      tile = this.grid.cellContent({ x: x, y: y });

      if (tile) {
        for (var direction = 0; direction < 4; direction++) {
          var vector = self.getVector(direction);
          var cell   = { x: x + vector.x, y: y + vector.y };

          var other  = self.grid.cellContent(cell);

          if (other && other.value === tile.value) {
            return true; // These two tiles can be merged
          }
        }
      }
    }
  }

  return false;
};

GameManager.prototype.positionsEqual = function (first, second) {
  return first.x === second.x && first.y === second.y;
};

// --- Nextcloud adaptation: bonus actions ---

GameManager.prototype.freshBonuses = function () {
  return { undo: BONUS_START, swap: BONUS_START, remove: BONUS_START };
};

// The state to return to when the last move is undone
GameManager.prototype.snapshot = function () {
  return {
    grid:  this.grid.serialize(),
    score: this.score,
    moves: this.moves,
    won:   this.won,
    over:  this.over
  };
};

// A charge is earned only the first time a tile is made in a game. Neither the
// charges nor this record are rolled back by undo, otherwise undoing and redoing
// the merge would produce free charges.
GameManager.prototype.awardBonus = function (value) {
  var type = BONUS_MILESTONES[value];

  if (!type || this.reached[value]) return;

  this.reached[value] = true;
  if (this.bonuses[type] < BONUS_MAX) this.bonuses[type]++;
};

GameManager.prototype.canUndo = function () {
  return !!this.previous && this.bonuses.undo > 0;
};

// Swap and remove change the board without a move, so they need a running game
GameManager.prototype.canUseBonus = function (type) {
  if (type === "undo") return this.canUndo();

  return this.bonuses[type] > 0 && !this.isGameTerminated();
};

// Take back the last move (also works on the game over / win screen)
GameManager.prototype.undo = function () {
  if (!this.canUndo()) return false;

  var state = this.previous;

  this.grid     = new Grid(state.grid.size, state.grid.cells);
  this.score    = state.score;
  this.moves    = state.moves;
  this.won      = state.won;
  this.over     = state.over;
  this.previous = null;
  this.bonuses.undo--;

  this.prepareTiles(); // render the restored tiles in place instead of popping them in
  this.actuator.continueGame(); // Clear the game won/lost message
  this.actuate();

  return true;
};

// Swap two tiles with different values
GameManager.prototype.swapTiles = function (first, second) {
  if (!this.canUseBonus("swap")) return false;

  var a = this.grid.cellContent(first);
  var b = this.grid.cellContent(second);

  if (!a || !b || a === b || a.value === b.value) return false;

  // A swap that locks the board would end the game with no way back (undo only
  // takes back moves), so try it first and refuse it if it does.
  this.grid.cells[first.x][first.y]   = b;
  this.grid.cells[second.x][second.y] = a;

  if (!this.movesAvailable()) {
    this.grid.cells[first.x][first.y]   = a;
    this.grid.cells[second.x][second.y] = b;
    return false;
  }

  this.prepareTiles(); // remember the old positions so that the tiles slide
  a.updatePosition(second);
  b.updatePosition(first);

  this.bonuses.swap--;
  this.previous = null; // undo only takes back moves

  this.actuate();

  return true;
};

// Remove every tile with the given value
GameManager.prototype.removeTilesOfValue = function (value) {
  if (!this.canUseBonus("remove")) return false;

  var self  = this;
  var found = false;

  this.prepareTiles();

  this.grid.eachCell(function (x, y, tile) {
    if (tile && tile.value === value) {
      self.grid.removeTile(tile);
      found = true;
    }
  });

  if (!found) return false;

  // Never leave an empty board: nothing could move on it
  if (this.grid.availableCells().length === this.size * this.size) {
    this.addStartTiles();
  }

  this.bonuses.remove--;
  this.previous = null;

  this.actuate();

  return true;
};

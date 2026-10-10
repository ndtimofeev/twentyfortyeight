// Nextcloud addition: buttons and board interaction for the bonus actions.
//
//   undo   - one click, takes back the last move
//   swap   - pick two tiles with different values, they trade places
//   remove - pick a tile, every tile with the same value disappears
//
// The rules themselves live in GameManager (undo, swapTiles, removeTilesOfValue).
function BonusUI(game) {
  this.game          = game;
  this.mode          = null; // "swap", "remove" or null
  this.selected      = null; // first tile picked for a swap, {x, y}
  this.overlay       = null; // highlight drawn over the selected tile
  this.container     = document.querySelector(".game-container");
  this.tileContainer = document.querySelector(".tile-container");
  this.hint          = document.querySelector(".bonus-hint");
  this.buttons       = {};

  var self = this;

  Array.prototype.forEach.call(document.querySelectorAll(".bonus-button"), function (button) {
    var type = button.getAttribute("data-bonus");

    self.buttons[type] = button;
    button.addEventListener("click", function () {
      self.activate(type);
      button.blur(); // keep Enter/Space from firing it again
    });
  });

  // Mouse clicks. Touch taps arrive through the "tap" event of the input manager.
  this.container.addEventListener("click", function (event) {
    self.tap({ x: event.clientX, y: event.clientY });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && self.mode) self.cancel();
  });
}

BonusUI.HINTS = {
  swap:   "Pick two tiles with different values to swap them.",
  remove: "Pick a tile: all tiles with the same value will be removed."
};

BonusUI.prototype.activate = function (type) {
  if (type === "undo") {
    this.cancel();
    this.game.undo();
  } else if (this.mode === type) {
    this.cancel(); // second click on the active button
  } else if (this.game.canUseBonus(type)) {
    this.setMode(type);
  }
};

BonusUI.prototype.setMode = function (type) {
  this.cancel();

  this.mode = type;
  this.container.classList.add("bonus-mode");
  this.buttons[type].classList.add("active");
  this.hint.textContent = BonusUI.HINTS[type] + " Press Esc to cancel.";
  this.hint.hidden = false;
};

BonusUI.prototype.cancel = function () {
  this.clearSelection();

  if (this.mode) this.buttons[this.mode].classList.remove("active");
  this.mode = null;
  this.container.classList.remove("bonus-mode");
  this.hint.hidden = true;
};

BonusUI.prototype.clearSelection = function () {
  this.selected = null;

  if (this.overlay && this.overlay.parentNode) {
    this.overlay.parentNode.removeChild(this.overlay);
  }
  this.overlay = null;
};

BonusUI.prototype.select = function (cell) {
  this.clearSelection();

  this.selected = cell;
  this.overlay  = document.createElement("div");
  this.overlay.className = "tile tile-selection tile-position-" + (cell.x + 1) + "-" + (cell.y + 1);
  this.tileContainer.appendChild(this.overlay);
};

// Which grid cell is under the given client coordinates, if any
BonusUI.prototype.cellAt = function (point) {
  var cells = document.querySelectorAll(".grid-cell");

  for (var i = 0; i < cells.length; i++) {
    var rect = cells[i].getBoundingClientRect();

    if (point.x >= rect.left && point.x <= rect.right &&
        point.y >= rect.top && point.y <= rect.bottom) {
      return { x: i % this.game.size, y: Math.floor(i / this.game.size) };
    }
  }

  return null;
};

BonusUI.prototype.tap = function (point) {
  if (!this.mode) return;

  var cell = this.cellAt(point);
  var tile = cell && this.game.grid.cellContent(cell);

  if (!tile) return;

  if (this.mode === "remove") {
    this.game.removeTilesOfValue(tile.value);
    return;
  }

  // swap
  if (!this.selected) {
    this.select(cell);
  } else if (this.selected.x === cell.x && this.selected.y === cell.y) {
    this.clearSelection(); // tapped the same tile again
  } else if (this.game.grid.cellContent(this.selected).value === tile.value) {
    this.select(cell); // swapping equal tiles is pointless, take the new one instead
  } else {
    this.game.swapTiles(this.selected, cell);
  }
};

// Called after every state change: refresh the counters, drop any pending pick
BonusUI.prototype.update = function () {
  this.cancel();

  for (var type in this.buttons) {
    var button = this.buttons[type];

    button.querySelector(".bonus-count").textContent = this.game.bonuses[type];
    button.disabled = !this.game.canUseBonus(type);
  }
};

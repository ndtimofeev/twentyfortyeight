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
  this.cells         = document.querySelectorAll(".grid-cell");
  this.focused       = null; // cell under keyboard focus
  this.buttons       = {};

  var self = this;

  Array.prototype.forEach.call(document.querySelectorAll(".bonus-button"), function (button) {
    var type = button.getAttribute("data-bonus");

    self.buttons[type] = button;
    button.addEventListener("click", function () {
      self.activate(type);
    });
  });

  Array.prototype.forEach.call(this.cells, function (element, index) {
    element.addEventListener("focus", function () {
      self.focused = { x: index % game.size, y: Math.floor(index / game.size) };
    });
  });

  // Mouse clicks. Touch taps arrive through the "tap" event of the input manager.
  this.container.addEventListener("click", function (event) {
    self.tap({ x: event.clientX, y: event.clientY });
  });

  document.addEventListener("keydown", function (event) {
    self.keydown(event);
  });
}

BonusUI.HINTS = {
  swap:   "Pick two tiles with different values to swap them.",
  remove: "Pick a tile: all tiles with the same value will be removed."
};
BonusUI.INSTRUCTIONS = " Use arrow keys to choose a cell and Enter or Space to select it. Press Esc or the button again to cancel.";

BonusUI.prototype.activate = function (type) {
  if (this.game.initializing || !this.game.grid) return;

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
  this.buttons[type].setAttribute("aria-pressed", "true");
  this.hint.textContent = BonusUI.HINTS[type] + BonusUI.INSTRUCTIONS;
  this.hint.hidden = false;

  // Roving tabindex leaves just one cell in the Tab order during selection.
  var cell = { x: 0, y: 0 };
  for (var i = 0; i < this.cells.length; i++) {
    var candidate = { x: i % this.game.size, y: Math.floor(i / this.game.size) };
    if (this.game.grid.cellContent(candidate)) {
      cell = candidate;
      break;
    }
  }
  this.focusCell(cell);
};

BonusUI.prototype.cancel = function () {
  var button = this.mode && this.buttons[this.mode];
  var returnFocus = button && Array.prototype.indexOf.call(this.cells, document.activeElement) !== -1;
  this.clearSelection();

  if (this.mode) {
    this.buttons[this.mode].classList.remove("active");
    this.buttons[this.mode].setAttribute("aria-pressed", "false");
  }
  this.mode = null;
  this.container.classList.remove("bonus-mode");
  this.hint.hidden = true;
  this.focused = null;
  Array.prototype.forEach.call(this.cells, function (element) {
    element.tabIndex = -1;
  });
  if (returnFocus && !button.disabled) button.focus();
};

BonusUI.prototype.focusCell = function (cell) {
  this.focused = cell;
  var selectedIndex = cell.y * this.game.size + cell.x;
  Array.prototype.forEach.call(this.cells, function (element, index) {
    element.tabIndex = index === selectedIndex ? 0 : -1;
  });
  this.cells[selectedIndex].focus();
};

BonusUI.prototype.keydown = function (event) {
  if (!this.mode || this.game.initializing || event.defaultPrevented ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!KeyboardInputManager.canHandleKeyEvent(event)) return;
  var target = event.target;

  if (event.key === "Escape") {
    event.preventDefault();
    this.cancel();
    return;
  }

  var directions = { ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1], ArrowLeft: [-1, 0] };
  var direction = directions[event.key];
  if (direction) {
    event.preventDefault();
    var cell = this.focused || { x: 0, y: 0 };
    this.focusCell({
      x: Math.max(0, Math.min(this.game.size - 1, cell.x + direction[0])),
      y: Math.max(0, Math.min(this.game.size - 1, cell.y + direction[1]))
    });
  } else if ((event.key === "Enter" || event.key === " " || event.key === "Spacebar") &&
             Array.prototype.indexOf.call(this.cells, target) !== -1) {
    event.preventDefault();
    this.selectCell(this.focused);
  }
};

BonusUI.prototype.clearSelection = function () {
  this.selected = null;

  if (this.overlay && this.overlay.parentNode) {
    this.overlay.parentNode.removeChild(this.overlay);
  }
  this.overlay = null;
  if (this.mode) this.hint.textContent = BonusUI.HINTS[this.mode] + BonusUI.INSTRUCTIONS;
  Array.prototype.forEach.call(this.cells, function (element) {
    element.setAttribute("aria-selected", "false");
  });
};

BonusUI.prototype.select = function (cell) {
  this.clearSelection();

  this.selected = cell;
  this.overlay  = document.createElement("div");
  this.overlay.className = "tile tile-selection tile-position-" + (cell.x + 1) + "-" + (cell.y + 1);
  this.tileContainer.appendChild(this.overlay);
  this.cells[cell.y * this.game.size + cell.x].setAttribute("aria-selected", "true");
  this.hint.textContent = "First tile selected. Pick a tile with a different value to swap. Press Esc to cancel.";
};

// Which grid cell is under the given client coordinates, if any
BonusUI.prototype.cellAt = function (point) {
  var cells = this.cells;

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
  if (!this.mode || this.game.initializing) return;

  var cell = this.cellAt(point);
  if (cell) this.focusCell(cell);
  this.selectCell(cell);
};

BonusUI.prototype.selectCell = function (cell) {
  if (!this.mode || this.game.initializing) return;
  var tile = cell && this.game.grid.cellContent(cell);

  if (!tile) return;

  if (this.mode === "remove") {
    if (this.game.removeTilesOfValue(tile.value)) this.cancel();
    return;
  }

  // swap
  if (!this.selected) {
    this.select(cell);
  } else if (this.selected.x === cell.x && this.selected.y === cell.y) {
    this.clearSelection(); // tapped the same tile again
  } else if (this.game.grid.cellContent(this.selected).value === tile.value) {
    this.select(cell); // swapping equal tiles is pointless, take the new one instead
  } else if (!this.game.swapTiles(this.selected, cell)) {
    // Refused: the swap would leave no moves and end the game
    this.clearSelection();
    this.hint.textContent = "That swap would end the game. Pick two other tiles.";
  } else {
    this.cancel();
  }
};

// Called after every state change: refresh the counters, drop any pending pick
BonusUI.prototype.update = function () {
  this.cancel();

  var self = this;
  Array.prototype.forEach.call(this.cells, function (element, index) {
    var cell = { x: index % self.game.size, y: Math.floor(index / self.game.size) };
    var tile = self.game.grid && self.game.grid.cellContent(cell);
    element.setAttribute("data-value", tile ? tile.value : 0);
    element.setAttribute("aria-label", "Row " + (cell.y + 1) + ", column " + (cell.x + 1) +
      ": " + (tile ? tile.value : "empty"));
  });

  Array.prototype.forEach.call(document.querySelectorAll(".restart-button, .retry-button, .keep-playing-button"), function (button) {
    button.disabled = !!(self.game.initializing ||
      (button.classList.contains("keep-playing-button") &&
       (!self.game.grid || !self.game.won || self.game.keepPlaying || self.game.over)));
  });

  for (var type in this.buttons) {
    var button = this.buttons[type];

    var count = this.game.bonuses ? this.game.bonuses[type] : 0;
    button.querySelector(".bonus-count").textContent = count;
    button.setAttribute("aria-label", type.charAt(0).toUpperCase() + type.slice(1) + ": " + count + " charges");
    button.disabled = !!this.game.initializing || !this.game.grid || !this.game.canUseBonus(type);
  }

  // A spent bonus must not leave focus on a disabled control.
  if (document.activeElement && document.activeElement.disabled && !this.game.initializing) {
    var restart = document.querySelector(".restart-button");
    if (restart) restart.focus();
  }
};

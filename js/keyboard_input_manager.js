function KeyboardInputManager() {
  this.events = {};

  if (window.navigator.msPointerEnabled) {
    //Internet Explorer 10 style
    this.eventTouchstart    = "MSPointerDown";
    this.eventTouchmove     = "MSPointerMove";
    this.eventTouchend      = "MSPointerUp";
  } else {
    this.eventTouchstart    = "touchstart";
    this.eventTouchmove     = "touchmove";
    this.eventTouchend      = "touchend";
  }

  this.listen();
}

KeyboardInputManager.prototype.on = function (event, callback) {
  if (!this.events[event]) {
    this.events[event] = [];
  }
  this.events[event].push(callback);
};

KeyboardInputManager.prototype.emit = function (event, data) {
  var callbacks = this.events[event];
  if (callbacks) {
    callbacks.forEach(function (callback) {
      callback(data);
    });
  }
};

// Global shortcuts belong to the game while its page is focused, and must not
// operate the board behind a Nextcloud modal or from another navigation control.
KeyboardInputManager.canHandleKeyEvent = function (event) {
  var root = document.querySelector("#tfe");
  var target = event.target;
  if (!root || (target && target !== document.body && target !== document.documentElement &&
                !root.contains(target))) return false;
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return false;

  var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  for (var i = 0; i < dialogs.length; i++) {
    var dialog = dialogs[i];
    if (root.contains(dialog) || dialog.hidden || dialog.getAttribute("aria-hidden") === "true" ||
        dialog.getClientRects().length === 0) continue;
    var style = window.getComputedStyle(dialog);
    if (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse") return false;
  }
  return true;
};

KeyboardInputManager.prototype.listen = function () {
  var self = this;
  var gameContainer = document.getElementsByClassName("game-container")[0];

  var map = {
    38: 0, // Up
    39: 1, // Right
    40: 2, // Down
    37: 3, // Left
    75: 0, // Vim up
    76: 1, // Vim right
    74: 2, // Vim down
    72: 3, // Vim left
    87: 0, // W
    68: 1, // D
    83: 2, // S
    65: 3  // A
  };

  // Respond to direction keys
  document.addEventListener("keydown", function (event) {
    // Bonus selection owns these keys, even though this listener was bound first.
    if (event.defaultPrevented || gameContainer.classList.contains("bonus-mode") ||
        !KeyboardInputManager.canHandleKeyEvent(event)) return;

    var modifiers = event.altKey || event.ctrlKey || event.metaKey ||
                    event.shiftKey;
    var mapped    = map[event.which];

    if (!modifiers) {
      if (mapped !== undefined) {
        event.preventDefault();
        self.emit("move", mapped);
      }
    }

    // R key restarts the game
    if (!modifiers && event.which === 82) {
      self.restart.call(self, event);
    }
  });

  // Respond to button presses
  this.bindButtonPress(".retry-button", this.restart);
  this.bindButtonPress(".restart-button", this.restart);
  this.bindButtonPress(".keep-playing-button", this.keepPlaying);

  // Respond to swipe events
  var touchStartClientX, touchStartClientY;

  function isButton(event) {
    var target = event.target;
    while (target && target !== gameContainer) {
      if (target.tagName === "BUTTON") return true;
      target = target.parentNode;
    }
    return false;
  }

  gameContainer.addEventListener(this.eventTouchstart, function (event) {
    touchStartClientX = touchStartClientY = undefined;
    if (isButton(event)) return; // native clicks also handle touch activation
    if ((!window.navigator.msPointerEnabled && event.touches.length > 1) ||
        (event.targetTouches && event.targetTouches.length > 1)) {
      return; // Ignore if touching with more than 1 finger
    }

    if (window.navigator.msPointerEnabled) {
      touchStartClientX = event.pageX;
      touchStartClientY = event.pageY;
    } else {
      touchStartClientX = event.touches[0].clientX;
      touchStartClientY = event.touches[0].clientY;
    }

    event.preventDefault();
  });

  gameContainer.addEventListener(this.eventTouchmove, function (event) {
    if (isButton(event)) return;
    event.preventDefault();
  });

  gameContainer.addEventListener(this.eventTouchend, function (event) {
    if (isButton(event) || touchStartClientX === undefined) return;
    if ((!window.navigator.msPointerEnabled && event.touches.length > 0) ||
        (event.targetTouches && event.targetTouches.length > 0)) {
      return; // Ignore if still touching with one or more fingers
    }

    var touchEndClientX, touchEndClientY;

    if (window.navigator.msPointerEnabled) {
      touchEndClientX = event.pageX;
      touchEndClientY = event.pageY;
    } else {
      touchEndClientX = event.changedTouches[0].clientX;
      touchEndClientY = event.changedTouches[0].clientY;
    }

    var dx = touchEndClientX - touchStartClientX;
    var absDx = Math.abs(dx);

    var dy = touchEndClientY - touchStartClientY;
    var absDy = Math.abs(dy);
    touchStartClientX = touchStartClientY = undefined;

    if (Math.max(absDx, absDy) > 10) {
      if (gameContainer.classList.contains("bonus-mode")) return;
      // (right : left) : (down : up)
      self.emit("move", absDx > absDy ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    } else {
      // Nextcloud adaptation: touchstart's preventDefault suppresses the click
      // event, so report taps ourselves (used to pick tiles for bonuses)
      self.emit("tap", { x: touchEndClientX, y: touchEndClientY });
    }
  });
};

KeyboardInputManager.prototype.restart = function (event) {
  event.preventDefault();
  this.emit("restart");
};

KeyboardInputManager.prototype.keepPlaying = function (event) {
  event.preventDefault();
  this.emit("keepPlaying");
};

KeyboardInputManager.prototype.bindButtonPress = function (selector, fn) {
  var button = document.querySelector(selector);
  button.addEventListener("click", fn.bind(this));
};

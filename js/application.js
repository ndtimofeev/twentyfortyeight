// Wait till the browser is ready to render the game (avoids glitches)
window.requestAnimationFrame(function () {
  var game = new GameManager(4, KeyboardInputManager, HTMLActuator, ServerStorageManager);
  document.getElementById("tfe").addEventListener("tfe:storage-status", function (event) {
    if (!game.initializing) game.setStatus(event.detail.message);
  });
});

// Renders the data returned by the scores API. Uses textContent only, since the
// display names come from other users.
function Leaderboard(list, me, empty) {
  this.list  = list;
  this.me    = me;
  this.empty = empty;
}

Leaderboard.prototype.render = function (data) {
  var self = this;

  this.list.textContent = "";
  this.empty.hidden = data.leaderboard.length > 0;

  data.leaderboard.forEach(function (row) {
    var item  = document.createElement("li");
    var rank  = document.createElement("span");
    var name  = document.createElement("span");
    var tile  = document.createElement("span");
    var score = document.createElement("strong");

    if (row.isMe) item.className = "tfe-mine";
    rank.className = "tfe-rank";
    rank.textContent = row.rank;
    rank.setAttribute("aria-label", "Place " + row.rank);
    item.value = row.rank;
    item.setAttribute("data-rank", row.rank);
    name.className = "tfe-name";
    name.textContent = row.displayName;
    tile.className = "tfe-tile-best";
    tile.textContent = row.bestTile || "";
    score.textContent = row.score;

    item.appendChild(rank);
    item.appendChild(name);
    item.appendChild(tile);
    item.appendChild(score);
    self.list.appendChild(item);
  });

  this.me.textContent = data.me
    ? "Your place: #" + data.me.rank + " (" + data.me.score + ")"
    : "You have no score yet.";
};

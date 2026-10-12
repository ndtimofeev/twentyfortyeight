// Shared with the server replay engine. The state is an unsigned 32-bit integer.
function SeededRandom(seed) {
  this.state = seed >>> 0;
  if (!this.state) throw new Error("Invalid game seed");
}

SeededRandom.prototype.next = function () {
  var value = this.state;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  this.state = value >>> 0;
  return this.state / 4294967296;
};

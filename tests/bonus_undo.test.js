const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, chooseMove } = require('./generate_replay_fixtures');
const copy = value => JSON.parse(JSON.stringify(value));
function started(version = 4) {
  const env = createGame(1, null, null, version);
  env.game.move(0);
  assert.equal(env.stored.actions.length, 1);
  return env;
}
function swap(game) {
  const tiles = game.grid.cells.flat().filter(Boolean);
  const a = tiles[0], b = tiles.find(tile => tile.value !== a.value);
  assert.ok(b);
  assert.equal(game.swapTiles({ x: a.x, y: a.y }, { x: b.x, y: b.y }), true);
}

for (const type of ['swap', 'remove']) for (const charges of [1, 2]) {
  test(`v4 Undo restores the ${type} board and ${charges}-charge supply after reload`, () => {
    let env = started();
    if (charges === 1) {
      if (type === 'swap') swap(env.game);
      else assert.equal(env.game.removeTilesOfValue(2), true);
    }
    assert.equal(env.game.bonuses[type], charges);
    const before = copy(env.game.snapshot());
    if (type === 'swap') swap(env.game);
    else assert.equal(env.game.removeTilesOfValue(charges === 1 ? 4 : 2), true);
    assert.equal(env.game.bonuses[type], charges - 1);
    assert.equal(env.game.previous.bonus, type);
    env = createGame(env.seed, copy(env.stored.state), copy(env.stored), 4);
    const rng = env.game.random.state;
    assert.equal(env.game.undo(), true);
    assert.deepEqual(copy(env.game.snapshot()), before);
    assert.equal(env.game.bonuses[type], charges);
    assert.equal(env.game.bonuses.undo, 1);
    assert.equal(env.game.random.state, rng, 'Undo preserves the forward random stream');
    assert.equal(env.game.previous, null);
    assert.equal(env.game.undo(), false, 'Undo cannot undo itself or skip another action');
    assert.equal(env.stored.actions.at(-1)[0], 'undo');
  });
}

test('v4 Undo after a move keeps the preceding bonus spent', () => {
  const env = started();
  swap(env.game);
  const afterSwap = copy(env.game.snapshot());
  env.game.move(chooseMove(env.game));
  assert.equal(env.game.previous.bonus, undefined);
  assert.equal(env.game.undo(), true);
  assert.deepEqual(copy(env.game.snapshot()), afterSwap);
  assert.equal(env.game.bonuses.swap, 1);
});

test('v4 failed bonus actions and a no-op move keep the successful bonus snapshot', () => {
  const env = started();
  swap(env.game);
  const snapshot = copy(env.game.previous), count = env.stored.actions.length;
  env.game.move(3); // Both actual seed-1 tiles are already in the left column.
  assert.equal(env.game.swapTiles({ x: 0, y: 0 }, { x: 3, y: 3 }), false);
  assert.equal(env.game.removeTilesOfValue(4096), false);
  assert.equal(env.stored.actions.length, count);
  assert.deepEqual(copy(env.game.previous), snapshot);
  assert.equal(env.game.undo(), true);
  assert.equal(env.game.bonuses.swap, 2);
});

test('v4 Undo reverses an empty-board Remove without erasing records or rewinding RNG', () => {
  const env = createGame(1, null, null, 4);
  const before = copy(env.game.snapshot()), rngBefore = env.game.random.state;
  assert.equal(env.game.removeTilesOfValue(2), true);
  assert.equal(env.game.grid.availableCells().length, 14);
  const rngAfter = env.game.random.state;
  assert.notEqual(rngBefore, rngAfter);
  assert.equal(env.game.undo(), true);
  assert.deepEqual(copy(env.game.snapshot()), before);
  assert.equal(env.game.bonuses.remove, 2);
  assert.equal(env.game.bonuses.undo, 1);
  assert.equal(env.game.random.state, rngAfter);
  assert.equal(env.game.maxTile, env.stored.bestTileEver);
});

for (const version of [1, 2, 3]) test(`legacy v${version} still refuses Undo after Swap or Remove`, () => {
  const env = started(version);
  swap(env.game);
  assert.equal(env.game.undo(), false);
  assert.equal(env.game.removeTilesOfValue(2), true);
  assert.equal(env.game.undo(), false);
});

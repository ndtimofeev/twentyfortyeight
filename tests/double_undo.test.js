const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, chooseMove } = require('./generate_replay_fixtures');
const copy = value => JSON.parse(JSON.stringify(value));
const position = game => copy({grid:game.grid.serialize(),score:game.score,moves:game.moves,won:game.won,over:game.over});
function action(game, type) {
  if (type === 'move') {
    const before=game.storageManager.actions.length;
    game.move(chooseMove(game));
    assert.equal(game.storageManager.actions.length,before+1);
    return;
  }
  const tiles=game.grid.cells.flat().filter(Boolean);
  if (type === 'remove') return assert.equal(game.removeTilesOfValue(tiles[0].value),true);
  const first=tiles[0],second=tiles.find(tile=>tile.value!==first.value);
  assert(second);
  assert.equal(game.swapTiles({x:first.x,y:first.y},{x:second.x,y:second.y}),true);
}

for (const pair of [['move','move'],['move','swap'],['swap','move'],['swap','swap'],['swap','remove'],['remove','remove'],['remove','move']]) {
  test(`v5 two consecutive Undo restore ${pair.join(' then ')} across reloads`, () => {
    let env=createGame(1,null,null,5);
    env.game.move(0);
    const before=position(env.game),charges=copy(env.game.bonuses);
    action(env.game,pair[0]);
    const middle=position(env.game);
    action(env.game,pair[1]);
    assert(env.game.previous.previous);
    assert.equal(env.game.previous.previous.previous,undefined,'The third snapshot is discarded');
    env=createGame(1,copy(env.stored.state),copy(env.stored),5);
    const rng=env.game.random.state,peak=env.stored.peakScore;
    assert.equal(env.game.undo(),true);
    assert.deepEqual(position(env.game),middle);
    assert.equal(env.game.bonuses.undo,1);
    assert(env.game.previous,'The earlier action remains reversible');
    env=createGame(1,copy(env.stored.state),copy(env.stored),5);
    assert.equal(env.game.undo(),true);
    assert.deepEqual(position(env.game),before);
    assert.equal(env.game.previous,null);
    assert.equal(env.game.bonuses.undo,0);
    assert.equal(env.game.bonuses.swap,charges.swap);
    assert.equal(env.game.bonuses.remove,charges.remove);
    assert.equal(env.game.random.state,rng);
    assert.equal(env.stored.peakScore,peak);
    assert.equal(env.game.undo(),false);
  });
}

test('v5 a new action after Undo branches from the restored position', () => {
  const env=createGame(1,null,null,5);
  action(env.game,'move');
  const first=position(env.game);
  action(env.game,'move');
  const second=position(env.game);
  action(env.game,'move');
  assert.equal(env.game.undo(),true);
  assert.deepEqual(position(env.game),second);
  action(env.game,'swap');
  assert.equal(env.game.undo(),true);
  assert.deepEqual(position(env.game),second);
  assert.deepEqual(copy(env.game.previous.grid),first.grid);
  assert.equal(env.game.previous.moves,first.moves);
  assert.equal(env.game.bonuses.swap,2);
});

test('v4 keeps one-level Undo while v5 accepts two', () => {
  for (const version of [1,2,3,4,5]) {
    const env=createGame(1,null,null,version);
    action(env.game,'move');
    action(env.game,'move');
    assert.equal(env.game.undo(),true);
    assert.equal(env.game.undo(),version===5);
  }
});

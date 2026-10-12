// Cross-tab and migration races with the real browser game and storage classes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGame, apply, chooseMove } = require('./generate_replay_fixtures');

const plain = value => JSON.parse(JSON.stringify(value));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }

// Server fixtures come from actual, successful seeded moves, not invented grids.
function packet(session, actions = [], revision = 0) {
  const replay = createGame(session.seed, null, null, session.version || 1);
  for (const action of actions) {
    const before = replay.stored.actions.length;
    apply(replay, action);
    assert.equal(replay.stored.actions.length, before + 1, 'server fixture action must be valid');
  }
  return { session: plain(session), actions: plain(actions), revision,
    state: plain({ ...replay.game.serialize(), peakScore: replay.stored.peakScore }) };
}

function load(options) {
  const shared = options.shared || new Map();
  const calls = [], timers = new Map();
  let manager, timerId = 0;
  const root = {
    dataset: { scoresUrl: '/nextcloud/apps/twentyfortyeight/api/scores',
      gamesUrl: '/nextcloud/apps/twentyfortyeight/api/games', user: 'alice', best: '1000', bestTile: '128' },
    dispatchEvent() {}
  };
  const storage = {
    get length() { return shared.size; },
    key(index) { return [...shared.keys()][index] || null; },
    getItem(key) { return shared.get(key) || null; },
    setItem(key, value) {
      if (options.beforeWrite) options.beforeWrite(key, String(value));
      shared.set(key, String(value));
    },
    removeItem(key) {
      if (options.beforeRemove) options.beforeRemove(key);
      shared.delete(key);
    }
  };
  const context = vm.createContext({
    console, JSON, Math, Number, Promise, Date: { now: () => 100000 },
    document: {
      visibilityState: 'visible', head: { getAttribute() { return 'test-request-token'; } },
      getElementById(id) { return id === 'tfe' ? root : {}; },
      querySelector() { return null; }, addEventListener() {}
    },
    window: { localStorage: storage, addEventListener() {} },
    CustomEvent: class {}, Leaderboard: class { render() {} },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, init) {
      const call = { url, init, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (options.fetch) {
        const intercepted = options.fetch(call);
        if (intercepted !== undefined) return intercepted;
      }
      if (url.endsWith('/games')) {
        if (init.method === 'PUT') {
          if (call.body.session !== options.store.game.session.token) {
            return Promise.resolve(response({ message: 'Game replaced', game: plain(options.store.game) }, 409));
          }
          options.store.game = packet(options.store.game.session, call.body.actions, options.store.game.revision + 1);
        }
        return Promise.resolve(response({ game: plain(options.store.game) }));
      }
      return Promise.resolve(response({ leaderboard: [], me: { score: 1000, bestTile: 128, rank: 1 } }));
    }
  });
  context.Input = class { on() {} };
  context.Actuator = class { actuate() {} continueGame() {} };
  context.BonusUI = class { update() {} tap() {} cancel() {} };
  for (const name of ['local_storage_manager', 'server_storage_manager', 'seeded_random', 'grid', 'tile', 'game_manager']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8'), context);
  }
  manager = new context.ServerStorageManager();
  if (options.beforePlayer) options.beforePlayer(manager, shared);
  context.Storage = class { constructor() { return manager; } };
  const player = vm.runInContext('new GameManager(4, Input, Actuator, Storage)', context);
  return { manager, player, shared, calls, context, timers, root,
    pendingProofs() { return [...shared.keys()].filter(key => key.startsWith(manager.queueKey + '.job.')); } };
}

function takeMove(env) {
  const direction = chooseMove(env.player);
  assert.notEqual(direction, null, 'fixture must offer a genuine valid move');
  const before = env.manager.actions.length;
  env.player.move(direction);
  assert.equal(env.manager.actions.length, before + 1, 'real GameManager must record the valid move');
}

for (const promotionOrigin of ['GET', 'PUT']) {
  for (const lateResult of ['success', 'conflict', 'offline']) {
    test(`remote New Game releases promotion freeze before old ${promotionOrigin}/${lateResult} completes`, async () => {
      const parent = { token: 'old-v2', seed: 1, version: 2 };
      const store = { game: packet(parent, [['move', 0]], 1) };
      const focus = deferred(), oldSave = deferred(), promotion = deferred();
      let reads = 0, promotions = 0;
      const env = load({ store, fetch(call) {
        if (call.url.endsWith('/games') && call.init.method === 'GET' && ++reads === 2) return focus.promise;
        if (call.init.method === 'PUT') {
          if (call.body.session === parent.token) return oldSave.promise;
          promotions++;
          return promotion.promise;
        }
      } });
      await settle();
      takeMove(env);
      const localActions = plain(env.manager.actions);
      const refreshing = env.manager.refreshGame();
      const saving = env.manager.flushGame();
      await settle();
      const upgraded = packet({ token: 'upgrade-v3', seed: 1, version: 3,
        previousToken: parent.token, cutover: 1 }, [['move', 0]], 2);
      if (promotionOrigin === 'GET') focus.resolve(response({ game: upgraded }));
      else oldSave.resolve(response({ game: upgraded }));
      await settle();
      assert.equal(promotions, 1);
      assert.equal(env.manager.gameTransitioning, true);
      assert.equal(env.player.canRecordAction(), false);

      const fresh = packet({ token: 'remote-new-v3', seed: 5, version: 3 });
      store.game = fresh;
      if (promotionOrigin === 'GET') {
        oldSave.resolve(response({ message: 'Another device started a game', game: fresh }, 409));
        await saving;
      } else {
        focus.resolve(response({ game: fresh }));
        await refreshing;
      }
      assert.equal(env.manager.session.token, fresh.session.token);
      assert.equal(env.player.rulesVersion, 3);
      assert.equal(env.manager.gameTransitioning, false, 'replacement must release the superseded freeze immediately');
      assert.equal(env.player.canRecordAction(), true);
      takeMove(env); // The superseded migration is still unresolved here.
      const newActions = plain(env.manager.actions);
      const newBoard = plain(env.player.serialize());

      if (lateResult === 'success') {
        promotion.resolve(response({ game: packet({ token: 'old-promoted-tail', seed: 1, version: 3,
          previousToken: parent.token, cutover: localActions.length }, localActions, 3) }));
      } else if (lateResult === 'conflict') promotion.resolve(response({ message: 'Game replaced', game: fresh }, 409));
      else promotion.reject(new TypeError('offline'));
      await Promise.all([saving, refreshing]);
      assert.equal(env.manager.session.token, fresh.session.token);
      assert.deepEqual(plain(env.manager.actions), newActions);
      assert.deepEqual(plain(env.player.serialize()), newBoard);
      assert.equal(env.manager.gameTransitioning, false);
      assert.equal(env.manager.gamePromotion, null);
      assert.equal(env.manager.gameInFlight, null);
      assert.equal(env.manager.gameRefreshInFlight, null);
      takeMove(env);
    });
  }
}

test('a superseded promotion finally cannot release a newer legitimate promotion', async () => {
  const parent = { token: 'legacy-a', seed: 1, version: 2 };
  const store = { game: packet(parent, [['move', 0]], 1) };
  const oldPromotion = deferred(), newPromotion = deferred();
  let promotions = 0;
  const env = load({ store, fetch(call) {
    if (call.init.method === 'PUT') return ++promotions === 1 ? oldPromotion.promise : newPromotion.promise;
  } });
  await settle();
  takeMove(env);
  const oldActions = plain(env.manager.actions);
  const first = env.manager.receiveGame(packet({ token: 'upgrade-a', seed: 1, version: 3,
    previousToken: parent.token, cutover: 1 }, [['move', 0]], 2), ++env.manager.requestSequence, true);
  await settle();
  assert.equal(env.manager.gameTransitioning, true);

  // A different supported legacy party is loaded, and its own offline tail
  // then needs a separate signed cutover. Both boards are actual seeded games.
  const nextParent = { token: 'legacy-b', seed: 5, version: 2 };
  await env.manager.receiveGame(packet(nextParent), ++env.manager.requestSequence, true);
  assert.equal(env.manager.gameTransitioning, false);
  takeMove(env);
  const nextActions = plain(env.manager.actions);
  const second = env.manager.receiveGame(packet({ token: 'upgrade-b', seed: 5, version: 3,
    previousToken: nextParent.token, cutover: 0 }), ++env.manager.requestSequence, true);
  await settle();
  assert.equal(promotions, 2);
  const currentPromotion = env.manager.gamePromotion;
  assert.equal(env.manager.gameTransitioning, true);
  assert.equal(env.player.canRecordAction(), false);

  oldPromotion.resolve(response({ game: packet({ token: 'old-upgrade-a-tail', seed: 1, version: 3,
    previousToken: parent.token, cutover: oldActions.length }, oldActions, 3) }));
  await first;
  assert.equal(env.manager.gameTransitioning, true, 'old finally must leave the new owner frozen');
  assert.equal(env.manager.gamePromotion, currentPromotion, 'old completion must not clear the new promise');
  assert.equal(env.manager.session.token, nextParent.token);
  const before = plain(env.manager.actions);
  env.player.move(chooseMove(env.player));
  assert.deepEqual(plain(env.manager.actions), before, 'new promotion still guards actual gameplay');

  newPromotion.resolve(response({ game: packet({ token: 'upgrade-b-tail', seed: 5, version: 3,
    previousToken: nextParent.token, cutover: nextActions.length }, nextActions, 1) }));
  await second;
  assert.equal(env.manager.gameTransitioning, false);
  assert.equal(env.manager.gamePromotion, null);
  assert.equal(env.manager.session.token, 'upgrade-b-tail');
  takeMove(env);
});

test('a short late ACK cannot discard a longer other-tab draft during offline reload', async () => {
  const session = { token: 'shared-v3', seed: 1, version: 3 };
  const store = { game: packet(session) };
  const shared = new Map(), shortAck = deferred();
  const first = load({ store, shared, fetch(call) {
    if (call.init.method === 'PUT') return shortAck.promise;
  } });
  await settle();
  takeMove(first);
  const frozen = plain(first.manager.getGameState());
  const saving = first.manager.flushGame();
  await settle();
  const second = load({ store, shared, fetch(call) {
    if (call.init.method === 'PUT') return Promise.reject(new TypeError('offline'));
  } });
  await settle();
  assert.deepEqual(plain(second.manager.actions), frozen.actions);
  for (let i = 0; i < 5; i++) takeMove(second);
  const ahead = plain(second.manager.getGameState());
  assert.equal(ahead.actions.length, 6);
  assert.equal(second.pendingProofs().length, 0, 'a higher personal record must not be needed to protect this board');

  store.game = packet(session, frozen.actions, 1);
  shortAck.resolve(response({ game: plain(store.game) }));
  await saving;
  assert.deepEqual(plain(first.manager.getGameState().actions), ahead.actions);
  await second.manager.flushGame(true);
  const returning = load({ store, shared, fetch() { return Promise.reject(new TypeError('offline')); } });
  await settle();
  assert.deepEqual(plain(returning.manager.actions), ahead.actions);
  assert.deepEqual(plain(returning.player.serialize()), plain(second.player.serialize()));
  takeMove(returning);
});

test('an ACK-confirmed checkpoint survives a cache read-check-write interleaving across tabs', async () => {
  const session = { token: 'cache-race-v3', seed: 1, version: 3 };
  const store = { game: packet(session) };
  const shared = new Map(), shortAck = deferred();
  let second, interleave = false, didInterleave = false, acceptingLong, ahead;
  const first = load({ store, shared, fetch(call) {
    if (call.init.method === 'PUT') return shortAck.promise;
  }, beforeWrite(key) {
    if (!interleave || key !== first.manager.local.gameStateKey) return;
    interleave = false;
    didInterleave = true;
    // Tab A has already chosen cache1. Another tab progresses and receives
    // ACK6 before A's synchronous setItem finally writes its stale value.
    for (let i = 0; i < 5; i++) takeMove(second);
    ahead = plain(second.manager.getGameState());
    store.game = packet(session, ahead.actions, 2);
    acceptingLong = second.manager.receiveGame(plain(store.game), ++second.manager.requestSequence, true);
    assert.equal(second.manager.gameDirty, false, 'the longer proof is server-confirmed before A writes');
  } });
  await settle();
  takeMove(first);
  const frozen = plain(first.manager.getGameState());
  const saving = first.manager.flushGame();
  await settle();
  second = load({ store, shared });
  await settle();
  assert.equal(second.manager.actions.length, 1);
  interleave = true;
  const ack1 = packet(session, frozen.actions, 1);
  shortAck.resolve(response({ game: ack1 }));
  await saving;
  await acceptingLong;
  assert.equal(didInterleave, true);
  assert.equal(ahead.actions.length, 6);
  assert.equal(second.pendingProofs().length, 0);
  assert.deepEqual(plain(first.manager.getGameState().actions), ahead.actions);
  const returning = load({ store, shared, fetch() { return Promise.reject(new TypeError('offline')); } });
  await settle();
  assert.deepEqual(plain(returning.manager.actions), ahead.actions);
  assert.deepEqual(plain(returning.player.serialize()), plain(second.player.serialize()));
  takeMove(returning);
});

test('a stale cache ACK and offline activation cannot replace another tab\'s authoritative New Game', async () => {
  const session = { token: 'before-new-game', seed: 1, version: 3 };
  const store = { game: packet(session) };
  const shared = new Map(), shortAck = deferred(), offlineStart = deferred();
  let second, interleave = false, didInterleave = false, acceptingNew;
  const fresh = packet({ token: 'after-new-game', seed: 5, version: 3 });
  const first = load({ store, shared, fetch(call) {
    if (call.init.method === 'PUT') return shortAck.promise;
  }, beforeWrite(key) {
    if (!interleave || key !== first.manager.local.gameStateKey) return;
    interleave = false;
    didInterleave = true;
    // A has chosen the old party's cache. B accepts the server's successful
    // New Game before A completes the stale compatibility-cache write.
    store.game = fresh;
    acceptingNew = second.manager.receiveGame(plain(fresh), ++second.manager.requestSequence, true);
    assert.equal(second.manager.session.token, fresh.session.token);
    assert.deepEqual(plain({ ...second.player.serialize(), peakScore: second.manager.gamePeakScore }), fresh.state);
  } });
  await settle();
  takeMove(first);
  const frozen = plain(first.manager.getGameState());
  const saving = first.manager.flushGame();
  await settle();
  second = load({ store, shared });
  await settle();

  // This tab has already captured the previous party but has not received its
  // startup GET. Its later offline fallback must not select that party again.
  const staleOffline = load({ store, shared, fetch(call) {
    if (call.url.endsWith('/games')) return offlineStart.promise;
  } });
  await settle();
  assert.equal(staleOffline.player.initializing, true);
  interleave = true;
  shortAck.resolve(response({ game: packet(session, frozen.actions, 1) }));
  await saving;
  await acceptingNew;
  assert.equal(didInterleave, true);
  assert.equal(first.manager.getGameState().session.token, fresh.session.token);
  assert.deepEqual(plain(first.manager.getGameState().actions), []);

  offlineStart.reject(new TypeError('offline'));
  await settle();
  assert.equal(staleOffline.player.initializing, false);
  assert.equal(staleOffline.manager.session.token, session.token, 'fallback really did activate the captured old party');
  assert.equal(staleOffline.manager.getGameState().session.token, fresh.session.token,
    'offline activation must preserve the authoritative party selection');
  const returning = load({ store, shared, fetch() { return Promise.reject(new TypeError('offline')); } });
  await settle();
  assert.equal(returning.manager.session.token, fresh.session.token);
  assert.deepEqual(plain({ ...returning.player.serialize(), peakScore: returning.manager.gamePeakScore }), fresh.state);
  assert.equal(returning.pendingProofs().length, 0);
  takeMove(returning);
});

test('canonical v3 reconciles an ancestor cache with the longer direct-parent draft', async () => {
  const ancestorSession = { token: 'mixed-ancestor-v1', seed: 1, version: 1 };
  const parentSession = { token: 'mixed-parent-v2', seed: 1, version: 2,
    previousToken: ancestorSession.token };
  const history = createGame(1, null, null, 2);
  for (let i = 0; i < 6; i++) apply(history, ['move', chooseMove(history.game)]);
  const actions = plain(history.stored.actions);
  const ancestor = packet(ancestorSession, actions.slice(0, 2));
  const parent = packet(parentSession, actions, 1);
  const currentSession = { token: 'mixed-current-v3', seed: 1, version: 3,
    previousToken: parentSession.token, ancestorToken: ancestorSession.token, cutover: 1 };
  const canonical = packet(currentSession, actions.slice(0, 1), 2);
  const store = { game: canonical };
  const saved = game => ({ ...game.state, session: game.session, actions: game.actions, revision: game.revision });
  let promotedActions;
  const env = load({ store, beforePlayer(manager, shared) {
    shared.set(manager.local.gameStateKey, JSON.stringify(saved(ancestor)));
    shared.set(manager.draftKey + 'parent-history', JSON.stringify({ state: saved(parent), savedAt: 100001 }));
    assert.equal(manager.getGameState().actions.length, 2, 'the offline cache starts from the ancestor');
  }, fetch(call) {
    if (call.init.method === 'PUT') {
      promotedActions = call.body.actions;
      // Restore the real v2 replay using the current v3 session: this is the
      // preserved old-rules prefix followed by a signed cutover, without moves.
      const upgraded = createGame(1, plain(history.game.serialize()), plain(history.stored), 3);
      store.game = { session: { ...currentSession, token: 'mixed-promoted-v3', cutover: actions.length },
        actions, revision: 3, state: plain({ ...upgraded.game.serialize(), peakScore: upgraded.stored.peakScore }) };
      return Promise.resolve(response({ game: store.game }));
    }
  } });
  await settle();
  assert.deepEqual(promotedActions, actions, 'promotion must include the six-action direct-parent tail');
  assert.equal(env.player.initializing, false);
  assert.equal(env.manager.session.token, 'mixed-promoted-v3');
  assert.equal(env.player.rulesVersion, 3);
  assert.deepEqual(plain(env.manager.actions), actions);
  assert.deepEqual(plain({ ...env.player.serialize(), peakScore: env.manager.gamePeakScore }), store.game.state);
  takeMove(env);
});

test('immutable prefix compaction cannot remove another tab\'s concurrent longer checkpoint', async () => {
  const session = { token: 'compaction-v3', seed: 1, version: 3 };
  const store = { game: packet(session) };
  const shared = new Map();
  let second, interleave = false, didInterleave = false, ahead;
  const first = load({ store, shared, beforeRemove(key) {
    if (!interleave || !key.startsWith(first.manager.draftKey)) return;
    interleave = false;
    didInterleave = true;
    // A's compaction captured a removable prefix key. B writes and compacts
    // its own longer immutable successor before A finishes removing that key.
    for (let i = 0; i < 5; i++) takeMove(second);
    ahead = plain(second.manager.getGameState());
  } });
  await settle();
  takeMove(first);
  second = load({ store, shared });
  await settle();
  assert.equal(second.manager.actions.length, 1);
  interleave = true;
  takeMove(first);
  assert.equal(didInterleave, true);
  assert.equal(ahead.actions.length, 6);
  assert.deepEqual(plain(first.manager.getGameState().actions), ahead.actions);
  const returning = load({ store, shared, fetch() { return Promise.reject(new TypeError('offline')); } });
  await settle();
  assert.deepEqual(plain(returning.manager.actions), ahead.actions);
  assert.deepEqual(plain(returning.player.serialize()), plain(second.player.serialize()));
  takeMove(returning);
});

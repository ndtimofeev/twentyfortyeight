const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const scores = (score = 1000, bestTile = 128) => ({ leaderboard: [], me: { score, bestTile, rank: 1 } });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function state(score, maxTile, randomState = 99) {
  const cells = Array.from({ length: 4 }, () => Array(4).fill(null));
  cells[0][0] = { position: { x: 0, y: 0 }, value: 2 };
  cells[1][0] = { position: { x: 1, y: 0 }, value: 2 };
  return { score, maxTile, randomState, grid: { size: 4, cells }, moves: 1,
    over: false, won: false, keepPlaying: false, bonuses: { undo: 2, swap: 2, remove: 2 }, reached: {}, previous: null };
}
function game(session, actions = [], revision = 0, board = state(0, 2)) {
  return { session, actions, revision, state: board };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function load(options = {}) {
  const shared = options.shared || new Map();
  const calls = [], rendered = [], statuses = [];
  const documentEvents = new Map(), windowEvents = new Map(), timers = new Map();
  let now = options.now || 100000, timerId = 0, sessionId = 0;
  let manager;
  const gameStore = options.gameStore || { game: options.serverGame || null };
  const root = {
    dataset: {
      scoresUrl: options.scoresUrl || '/nextcloud/apps/twentyfortyeight/api/scores',
      gamesUrl: '/nextcloud/apps/twentyfortyeight/api/games',
      user: 'alice', best: String(options.best || 1000), bestTile: String(options.bestTile || 128)
    },
    dispatchEvent(event) { statuses.push(event.detail); }
  };
  const document = {
    visibilityState: 'visible',
    getElementById(id) { return id === 'tfe' ? root : {}; },
    head: { getAttribute() { return options.requestToken || 'nextcloud-request-token'; } },
    querySelector() { return null; },
    addEventListener(type, fn) { documentEvents.set(type, fn); }
  };
  const storage = {
    get length() { return shared.size; },
    key(index) { return [...shared.keys()][index] || null; },
    setItem(key, value) {
      if (options.failStorage && options.failStorage('set', key)) throw new Error('storage unavailable');
      if (options.beforeWrite) options.beforeWrite(key, value);
      shared.set(key, String(value));
    },
    getItem(key) { return shared.get(key) || null; },
    removeItem(key) {
      if (options.failStorage && options.failStorage('remove', key)) throw new Error('storage unavailable');
      shared.delete(key);
    }
  };
  const context = vm.createContext({
    console, JSON, Math, Number, Promise,
    Date: { now: () => now },
    document,
    window: {
      localStorage: storage,
      addEventListener(type, fn) { windowEvents.set(type, fn); }
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    Leaderboard: class { render(data) { rendered.push(plain(data)); } },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, due: now + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, init) {
      const call = { url, init, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (options.fetch) {
        const result = options.fetch(call);
        if (result !== undefined) return result;
      }
      if (url.endsWith('/games')) {
        if (init.method === 'POST') {
          if (!gameStore.game || call.body.restart) gameStore.game = game({ token: 'session-' + (++sessionId), seed: 123, version: 1 });
        } else if (init.method === 'PUT') {
          gameStore.game = game(plain(manager.session), call.body.actions, (gameStore.game ? gameStore.game.revision : 0) + 1,
            plain(manager.activeState || state(manager.gamePeakScore, manager.gameBestTile)));
        }
        return Promise.resolve(response({ game: gameStore.game }));
      }
      return Promise.resolve(response(scores(options.best || 1000, options.bestTile || 128)));
    }
  });
  for (const name of ['local_storage_manager', 'server_storage_manager']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8'), context);
  }
  manager = new context.ServerStorageManager();
  return {
    manager, calls, rendered, statuses, root, shared, document, timers, context, gameStore,
    scorePosts() { return calls.filter(call => call.init.method === 'POST' && call.url.endsWith('/scores')); },
    pending() {
      return [...shared].filter(([key]) => key.startsWith(manager.queueKey + '.job.')).map(([, value]) => JSON.parse(value));
    },
    emitDocument(type) { documentEvents.get(type)(); },
    emitWindow(type, event) { windowEvents.get(type)(event); },
    async advance(ms) {
      const target = now + ms;
      for (let i = 0; i < 1000; i++) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
        await settle();
        assert.ok(i < 999, 'timer processing must not spin');
      }
      now = target;
      await settle();
    }
  };
}

async function start(env) {
  await settle();
  await env.manager.prepareGame(null);
  return env.manager;
}

function move(manager, direction, score, bestTile = 128) {
  manager.recordAction(['move', direction]);
  manager.updateScore(score, { bestTile, moves: manager.actions.length });
}

test('failed submission stays durable and retries without a new score', async () => {
  let posts = 0;
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
      if (++posts === 1) return Promise.reject(new TypeError('network unavailable'));
      return Promise.resolve(response(scores(1200)));
    }
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  assert.equal(await manager.flush(), false);
  assert.equal(env.pending().length, 1);
  assert.equal(env.pending()[0].attempts, 1);
  assert.equal(manager.submitted, 1000);
  assert.equal(manager.getBestScore(), 1200);
  assert.equal(env.root.dataset.storageState, 'offline');

  // A non-scoring move refreshes the log without discarding the retry deadline.
  move(manager, 1, 1200);
  await env.advance(999);
  assert.equal(posts, 1);
  await env.advance(1);
  assert.equal(posts, 2);
  assert.deepEqual(env.scorePosts()[1].body, { session: 'session-1', actions: [['move', 3], ['move', 1]] });
  assert.deepEqual(env.pending(), []);
  assert.equal(manager.submitted, 1200);
});

test('online retries a saved game immediately rather than waiting for another move', async () => {
  let online = false;
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
      return online ? Promise.resolve(response(scores(1500))) : Promise.reject(new TypeError('offline'));
    }
  } });
  const manager = await start(env);
  move(manager, 3, 1500);
  await manager.flush();
  online = true;
  env.emitWindow('online');
  await settle();
  assert.equal(env.scorePosts().length, 2);
  assert.deepEqual(env.pending(), []);
  assert.equal(env.root.dataset.storageState, 'saved');
});

test('restart and reload preserve old-party jobs separately from the current board', async () => {
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.reject(new TypeError('offline'));
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  manager.setGameState(state(1200, 128));
  await manager.flush();
  await manager.startNewGame();
  assert.equal(manager.getGameState(), null);
  assert.equal(env.pending().length, 1);

  await manager.prepareGame(null);
  move(manager, 2, 1600, 256);
  manager.setGameState(state(1600, 256, 777));
  assert.deepEqual(env.pending().map(job => job.session), ['session-1', 'session-2']);

  const reloaded = load({ shared: env.shared, fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response(scores(1600, 256)));
  } });
  const saved = reloaded.manager.getGameState();
  assert.equal((await reloaded.manager.prepareGame(saved)).randomState, 777);
  assert.equal(reloaded.manager.session.token, 'session-2');
  assert.deepEqual(plain(reloaded.manager.actions), [['move', 2]]);
  assert.equal(reloaded.calls.filter(call => call.url.endsWith('/games') && call.init.method === 'POST').length, 0);
  await reloaded.advance(0); // the new party is eligible even while the old one backs off
  await reloaded.advance(1000);
  assert.deepEqual(reloaded.scorePosts().map(call => call.body.session).sort(), ['session-1', 'session-2']);
  assert.deepEqual(reloaded.pending(), []);
});

test('in-flight actions are frozen and a newer log is submitted serially', async () => {
  const first = deferred();
  let posts = 0;
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
      return ++posts === 1 ? first.promise : Promise.resolve(response(scores(1400, 256)));
    }
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  const request = manager.flush();
  await settle();
  move(manager, 0, 1400, 256);
  assert.equal(manager.flush(), request);
  assert.equal(posts, 1);
  assert.deepEqual(env.scorePosts()[0].body, { session: 'session-1', actions: [['move', 3]] });
  assert.equal(env.pending()[0].actions.length, 2);

  first.resolve(response(scores(1200)));
  await request;
  assert.equal(env.pending().length, 1);
  await env.advance(0);
  assert.equal(posts, 2);
  assert.deepEqual(env.scorePosts()[1].body, { session: 'session-1', actions: [['move', 3], ['move', 0]] });
  assert.deepEqual(env.pending(), []);
});

test('a higher tile is submitted even when the game score is below the personal best', async () => {
  const env = load({ best: 20000, bestTile: 512, fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response(scores(20000, 1024)));
  } });
  const manager = await start(env);
  move(manager, 3, 8192, 1024);
  assert.equal(env.pending()[0].bestTile, 1024);
  await manager.flush();
  assert.equal(env.scorePosts().length, 1);
  assert.equal(manager.submittedTile, 1024);
  assert.equal(manager.getBestScore(), 20000);
  assert.deepEqual(Object.keys(env.scorePosts()[0].body).sort(), ['actions', 'session']);
});

test('a late initial GET cannot replace the newer submission leaderboard', async () => {
  const initial = deferred();
  const env = load({ fetch(call) {
    if (call.init.method === 'GET' && call.url.endsWith('/scores')) return initial.promise;
    if (call.url.endsWith('/scores')) return Promise.resolve(response(scores(1400, 256)));
  } });
  const manager = await start(env);
  move(manager, 3, 1400, 256);
  await manager.flush();
  assert.equal(env.rendered.at(-1).me.score, 1400);
  initial.resolve(response(scores(1000)));
  await settle();
  assert.equal(env.rendered.length, 1);
  assert.equal(env.rendered.at(-1).me.score, 1400);
});

test('hiding the page submits with keepalive and keeps the durable copy until acknowledgement', async () => {
  const pending = deferred();
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return pending.promise;
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  env.document.visibilityState = 'hidden';
  env.emitDocument('visibilitychange');
  await settle();
  const call = env.scorePosts()[0];
  assert.equal(call.init.keepalive, true);
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.headers.requesttoken, 'nextcloud-request-token');
  assert.equal(env.pending().length, 1);
  pending.resolve(response(scores(1200)));
  await manager.inFlight;
  assert.deepEqual(env.pending(), []);
});

test('a new board cannot start offline and legacy unverified boards are not resumed', async () => {
  const env = load({ fetch(call) {
    if (call.url.endsWith('/games')) return Promise.reject(new TypeError('offline'));
  } });
  await settle();
  await assert.rejects(env.manager.prepareGame({ score: 999999, grid: {} }), /offline/);
  assert.equal(env.manager.session, null);
  assert.equal(env.root.dataset.storageState, 'offline');
  assert.throws(() => env.manager.recordAction(['move', 0]), /server-issued/);
});

test('verification errors remain visible and durable without an endless retry loop', async () => {
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response({ message: 'Invalid action log' }, 400));
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  assert.equal(await manager.flush(), false);
  assert.equal(env.pending()[0].blocked, true);
  assert.equal(env.root.dataset.storageState, 'error');
  assert.match(env.root.dataset.storageMessage, /could not be verified/);
  assert.match(env.root.dataset.storageMessage, /Start a new game/);
  await env.advance(60000);
  assert.equal(env.scorePosts().length, 1);
  assert.equal(env.pending().length, 1);

  const reloaded = load({ shared: env.shared });
  await reloaded.advance(60000);
  assert.equal(reloaded.scorePosts().length, 0);
  assert.equal(reloaded.pending()[0].failureStatus, 400);
  assert.equal(reloaded.pending()[0].blocked, true);
  assert.match(reloaded.root.dataset.storageMessage, /could not be verified/);
});

for (const status of [401, 403, 412]) {
  test('HTTP ' + status + ' pauses the proof until a reload can renew authentication', async () => {
    const env = load({ fetch(call) {
      if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
        return Promise.resolve(response({ message: 'Authentication or CSRF check failed' }, status));
      }
    } });
    const manager = await start(env);
    move(manager, 3, 1200);
    assert.equal(await manager.flush(), false);
    assert.equal(env.pending()[0].failureStatus, status);
    assert.equal(env.pending()[0].blocked, true);
    assert.match(env.root.dataset.storageMessage, /Sign in again or refresh/);
    await env.advance(60000);
    env.emitWindow('online');
    await settle();
    assert.equal(env.scorePosts().length, 1, 'online must not repeat a request using the old CSRF token');

    const reloaded = load({ shared: env.shared, requestToken: 'renewed-request-token', fetch(call) {
      if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
        assert.equal(call.init.headers.requesttoken, 'renewed-request-token');
        return Promise.resolve(response(scores(1200)));
      }
    } });
    assert.equal(reloaded.pending()[0].blocked, false);
    await reloaded.advance(0);
    assert.equal(reloaded.scorePosts().length, 1);
    assert.deepEqual(reloaded.scorePosts()[0].body, { session: 'session-1', actions: [['move', 3]] });
    assert.deepEqual(reloaded.pending(), []);
    assert.equal(reloaded.manager.submitted, 1200);
  });
}

test('state and submission queues are isolated by the Nextcloud installation URL', async () => {
  const shared = new Map();
  const first = load({ shared, scoresUrl: '/first/apps/twentyfortyeight/api/scores' });
  const second = load({ shared, scoresUrl: '/second/apps/twentyfortyeight/api/scores' });
  await start(first);
  await start(second);
  move(first.manager, 3, 1200);
  first.manager.setGameState(state(1200, 128));
  assert.notEqual(first.manager.queueKey, second.manager.queueKey);
  assert.equal(second.manager.getGameState().score, 0);
  assert.deepEqual(second.manager.getGameState().actions, []);
  assert.deepEqual(second.pending(), []);
});

test('storage quota failures preserve newer in-memory proofs until they can be submitted', async () => {
  let full = false, online = false;
  const env = load({
    failStorage() { return full; },
    fetch(call) {
      if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
        return online ? Promise.resolve(response(scores(1400))) : Promise.reject(new TypeError('offline'));
      }
    }
  });
  const manager = await start(env);
  move(manager, 3, 1200);
  assert.equal(env.pending()[0].actions.length, 1);
  full = true;
  move(manager, 1, 1400);
  assert.equal(manager.queueDirty, true);
  assert.equal(env.pending()[0].actions.length, 1); // the old durable copy
  await manager.flush();
  assert.equal(manager.maximalQueue()[0].actions.length, 2);
  assert.equal(env.scorePosts()[0].body.actions.length, 2);
  assert.match(env.root.dataset.storageMessage, /Keep this page open/);
  await assert.doesNotReject(manager.clearGameState());
  assert.equal(manager.queue.length, 2); // durable prefix plus the newer unwritten proof

  full = false;
  online = true;
  env.emitWindow('online');
  await settle();
  assert.equal(env.scorePosts()[1].body.actions.length, 2);
  assert.deepEqual(env.pending(), []);
  assert.equal(manager.queueDirty, false);
});

test('unavailable localStorage uses memory and reports that a reload cannot preserve it', async () => {
  let online = false;
  const env = load({
    failStorage() { return true; },
    fetch(call) {
      if (call.init.method === 'POST' && call.url.endsWith('/scores')) {
        return online ? Promise.resolve(response(scores(1200))) : Promise.reject(new TypeError('offline'));
      }
    }
  });
  const manager = await start(env);
  move(manager, 3, 1200);
  await manager.flush();
  assert.equal(manager.persistent, false);
  assert.equal(manager.queue.length, 1);
  assert.match(env.root.dataset.storageMessage, /storage is unavailable/);
  online = true;
  env.emitWindow('online');
  await settle();
  assert.equal(env.scorePosts().length, 2);
  assert.deepEqual(plain(manager.queue), []);
});

test('a late initial GET failure does not replace a successful save status', async () => {
  const initial = deferred();
  const env = load({ fetch(call) {
    if (call.init.method === 'GET' && call.url.endsWith('/scores')) return initial.promise;
    if (call.url.endsWith('/scores')) return Promise.resolve(response(scores(1200)));
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  await manager.flush();
  assert.equal(env.root.dataset.storageState, 'saved');
  initial.reject(new TypeError('offline'));
  await settle();
  assert.equal(env.root.dataset.storageState, 'saved');
});

test('invalid saved boards are backed up before obtaining a new server session', async () => {
  const env = load();
  const manager = await start(env);
  move(manager, 3, 1200);
  const malformed = Object.assign(state(1200, 128), {
    session: plain(manager.session), actions: [['move', 3]], grid: { size: 4, cells: [] }
  });
  assert.equal((await manager.prepareGame(malformed)).score, 0);
  assert.equal(manager.session.token, 'session-1');
  assert.deepEqual(JSON.parse(env.shared.get(manager.local.gameStateKey + '.invalid')), malformed);
  assert.equal(env.pending()[0].session, 'session-1');

  env.shared.set(manager.local.gameStateKey, '{broken json');
  assert.deepEqual(manager.getGameState(), plain(manager.activeState), 'an intact checkpoint restores a broken shared cache');
  assert.equal(env.shared.get(manager.local.gameStateKey + '.invalid'), '{broken json');
  assert.equal(env.pending()[0].session, 'session-1');
  for (const key of env.shared.keys()) if (key.startsWith(manager.draftKey)) env.shared.delete(key);
  assert.equal(manager.getGameState(), null, 'an unreadable cache without a checkpoint cannot be restored');
});

test('restoring an older board does not downgrade its newer queued proof', async () => {
  const env = load();
  const manager = await start(env);
  move(manager, 3, 1200);
  manager.setGameState(state(1200, 128));
  const older = manager.getGameState();
  move(manager, 1, 1400);
  assert.equal(env.pending()[0].actions.length, 2);
  await manager.prepareGame(older);
  manager.updateScore(1200, { bestTile: 128 });
  assert.equal(env.pending()[0].actions.length, 2);
  assert.equal(env.pending()[0].score, 1400);

  // A different continuation of the restored board gets its own queued proof.
  move(manager, 0, 1300);
  assert.equal(env.pending().length, 2);
  assert.deepEqual(env.pending().map(job => job.actions), [
    [['move', 3], ['move', 1]], [['move', 3], ['move', 0]]
  ]);
});

test('malformed successful responses never acknowledge a pending proof', async () => {
  const env = load({ fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response({ leaderboard: [] }));
  } });
  const manager = await start(env);
  move(manager, 3, 1200);
  assert.equal(await manager.flush(), false);
  assert.equal(env.pending().length, 1);
  assert.equal(env.pending()[0].blocked, false);
  assert.equal(env.root.dataset.storageState, 'error');
});

test('the actual GameManager board, RNG and action log survive a restore', async () => {
  const env = load();
  env.context.Input = class { on() {} };
  env.context.Actuator = class { actuate() {} continueGame() {} };
  env.context.BonusUI = class { update() {} tap() {} };
  env.context.Storage = class { constructor() { return env.manager; } };
  for (const name of ['seeded_random', 'grid', 'tile', 'game_manager']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8'), env.context);
  }
  const game = vm.runInContext('new GameManager(4, Input, Actuator, Storage)', env.context);
  await settle();
  assert.equal(game.initializing, false);
  assert.ok(game.grid);
  for (let i = 0; i < 12; i++) game.move(i % 4);
  const saved = env.manager.getGameState();
  assert.equal(env.manager.validSavedState(saved), true);
  assert.ok(saved.actions.length > 0);
  const sessions = env.calls.filter(call => call.url.endsWith('/games') && call.init.method === 'POST').length;

  const restored = vm.runInContext('new GameManager(4, Input, Actuator, Storage)', env.context);
  await settle();
  assert.deepEqual(plain(restored.grid.serialize()), saved.grid);
  assert.equal(restored.random.state, saved.randomState);
  assert.equal(restored.score, saved.score);
  assert.deepEqual(plain(env.manager.actions), saved.actions);
  assert.equal(env.calls.filter(call => call.url.endsWith('/games') && call.init.method === 'POST').length, sessions);
});

test('interleaved writes from two tabs preserve proofs of different game sessions', async () => {
  const shared = new Map();
  let interleave = false, second;
  const first = load({ shared,
    fetch(call) {
      if (call.url.endsWith('/games') && call.init.method === 'POST') return Promise.resolve(response({ game: game({ token: 'tab-A', seed: 123, version: 1 }) }));
    },
    beforeWrite(key) {
      if (interleave && key.startsWith(first.manager.queueKey + '.job.')) {
        interleave = false;
        move(second.manager, 1, 1600);
      }
    }
  });
  second = load({ shared, fetch(call) {
    if (call.url.endsWith('/games') && call.init.method === 'POST') return Promise.resolve(response({ game: game({ token: 'tab-B', seed: 456, version: 1 }) }));
  } });
  await start(first);
  await start(second);
  interleave = true;
  move(first.manager, 3, 1200);

  assert.equal(interleave, false, 'the second tab writes after the first has read but before it writes');
  assert.deepEqual(first.pending().map(job => job.session).sort(), ['tab-A', 'tab-B']);
  first.emitWindow('storage', { key: first.manager.queueKey + '.job.some-id' });
  second.emitWindow('storage', { key: second.manager.queueKey + '.job.some-id' });
  assert.equal(first.manager.queue.length, 2);
  assert.equal(second.manager.queue.length, 2);
  assert.equal(shared.has(first.manager.queueKey), false, 'there is no shared array to overwrite');
});

test('interleaved branches of the same restored session retain two immutable proofs', async () => {
  const shared = new Map();
  const writtenActions = new Map();
  let interleave = false, second;
  const first = load({ shared, beforeWrite(key, raw) {
    if (!key.includes('.job.')) return;
    const job = JSON.parse(raw);
    if (writtenActions.has(key)) assert.deepEqual(job.actions, writtenActions.get(key), 'a proof key must not change its action log');
    writtenActions.set(key, job.actions);
    if (interleave && job.actions.length === 2) {
      interleave = false;
      move(second.manager, 1, 1500);
    }
  } });
  const saved = Object.assign(state(1200, 128), {
    session: { token: 'shared-session', seed: 123, version: 1 }, actions: [['move', 3]]
  });
  await first.manager.prepareGame(saved);
  first.manager.updateScore(1200, { bestTile: 128 });
  second = load({ shared });
  await second.manager.prepareGame(saved);
  interleave = true;
  move(first.manager, 0, 1400);

  const logs = first.pending().map(job => job.actions).sort((a, b) => a[1][1] - b[1][1]);
  assert.deepEqual(logs, [[['move', 3], ['move', 0]], [['move', 3], ['move', 1]]]);
  assert.equal(new Set(first.pending().map(job => job.id)).size, 2);
  first.manager.readQueue();
  second.manager.readQueue();
  assert.equal(first.manager.queue.length, 2);
  assert.equal(second.manager.queue.length, 2);
});

test('legacy queue migration creates separate proof keys before archiving the array', async () => {
  const shared = new Map();
  const url = '/nextcloud/apps/twentyfortyeight/api/scores';
  const key = 'twentyfortyeight.submissions.' + encodeURIComponent(url) + '.alice';
  const legacy = [{ id: 'legacy-proof', session: 'older-session', actions: [['move', 3]], score: 1200,
    bestTile: 128, blocked: false, attempts: 0, nextAttempt: 0 }];
  shared.set(key, JSON.stringify(legacy));
  const env = load({ shared, fetch(call) {
    if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response(scores(1200)));
  } });
  assert.equal(shared.has(key), false);
  assert.deepEqual(JSON.parse(shared.get(key + '.legacy')), legacy);
  assert.equal(env.pending()[0].session, 'older-session');
  await env.advance(0);
  assert.deepEqual(env.pending(), []);
  assert.deepEqual(env.scorePosts()[0].body, { session: 'older-session', actions: [['move', 3]] });
});

test('twenty quota-blocked moves retain one full proof and require only one successful POST', async () => {
  const env = load({
    failStorage(operation, key) { return operation === 'set' && key.includes('.job.'); },
    fetch(call) {
      if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response(scores(1200)));
    }
  });
  const manager = await start(env);
  for (let i = 1; i <= 20; i++) move(manager, i % 4, 1000 + i * 10);
  assert.equal(manager.queue.length, 1);
  assert.equal(Object.keys(manager.dirtyProofs).length, 1);
  assert.equal(manager.queue.reduce((sum, proof) => sum + proof.actions.length, 0), 20);
  assert.deepEqual(env.pending(), []);

  assert.equal(await manager.flush(), true);
  assert.equal(env.scorePosts().length, 1);
  assert.equal(env.scorePosts()[0].body.actions.length, 20);
  assert.equal(manager.queue.length, 0);
  assert.equal(Object.keys(manager.dirtyProofs).length, 0);
  await env.advance(60000);
  assert.equal(env.scorePosts().length, 1);
});

test('ACK of a quota-blocked successor clears its durable prefix without resubmitting it', async () => {
  let full = false;
  const env = load({
    failStorage(operation, key) { return full && operation === 'set' && key.includes('.job.'); },
    fetch(call) {
      if (call.init.method === 'POST' && call.url.endsWith('/scores')) return Promise.resolve(response(scores(1210)));
    }
  });
  const manager = await start(env);
  move(manager, 3, 1010);
  assert.equal(env.pending()[0].actions.length, 1);
  full = true;
  for (let i = 2; i <= 21; i++) move(manager, i % 4, 1000 + i * 10);
  assert.equal(manager.queue.length, 2, 'the durable prefix remains until its complete successor is accepted');
  assert.equal(Object.keys(manager.dirtyProofs).length, 1);
  assert.equal(env.pending()[0].actions.length, 1);
  assert.equal(manager.maximalQueue()[0].actions.length, 21);

  assert.equal(await manager.flush(), true);
  assert.deepEqual(env.pending(), []);
  assert.equal(manager.queue.length, 0);
  assert.equal(Object.keys(manager.dirtyProofs).length, 0);
  assert.equal(manager.queueDirty, false);
  await env.advance(60000);
  assert.equal(env.scorePosts().length, 1);
});

const session = token => ({ token, seed: 123, version: 1 });
const localGame = server => Object.assign({}, plain(server.state), {
  session: plain(server.session), actions: plain(server.actions), revision: server.revision
});
const activePuts = env => env.calls.filter(call => call.url.endsWith('/games') && call.init.method === 'PUT');

test('startup uses the canonical server board including RNG, bonuses and undo snapshot', async () => {
  const board = Object.assign(state(48, 16, 123456), { bonuses: { undo: 1, swap: 0, remove: 2 }, previous: state(32, 16, 9) });
  const canonical = game(session('shared'), [['move', 3], ['move', 0]], 7, board);
  const env = load({ serverGame: canonical });
  const older = localGame(game(session('shared'), [['move', 3]], 2, state(32, 8)));
  const restored = await env.manager.prepareGame(older);
  assert.equal(restored.randomState, 123456);
  assert.deepEqual(restored.bonuses, board.bonuses);
  assert.deepEqual(restored.previous, board.previous);
  assert.equal(restored.revision, 7);
  assert.deepEqual(plain(env.manager.actions), canonical.actions);
  assert.equal(env.manager.gameDirty, false);
  assert.equal(env.calls.filter(call => call.url.endsWith('/games') && call.init.method === 'POST').length, 0);

  const corrupted = Object.assign(localGame(canonical), { score: 9999, randomState: 55 });
  assert.equal((await env.manager.prepareGame(corrupted)).score, 48, 'equal histories use the server board');
});

test('a strictly newer local history keeps its board and adopts the server revision before saving', async () => {
  const canonical = game(session('shared'), [['move', 3]], 4, state(8, 4));
  const env = load({ serverGame: canonical });
  const newer = localGame(game(session('shared'), [['move', 3], ['move', 0]], 2, state(24, 8, 777)));
  const restored = await env.manager.prepareGame(newer);
  assert.equal(restored.score, 24);
  assert.equal(restored.randomState, 777);
  assert.equal(env.manager.revision, 4);
  await env.advance(0);
  assert.deepEqual(activePuts(env)[0].body, { session: 'shared', actions: newer.actions, revision: 4 });
  assert.equal(env.manager.revision, 5);
  assert.equal(env.manager.getGameState().revision, 5);
});

test('all actions below the personal best sync periodically during continuous play', async () => {
  const env = load({ best: 20000, bestTile: 512 });
  const manager = await start(env);
  for (let i = 0; i < 5; i++) {
    move(manager, i % 4, i * 4, 8);
    manager.setGameState(state(i * 4, 8, 100 + i));
    await env.advance(200);
  }
  assert.equal(env.scorePosts().length, 0);
  assert.equal(activePuts(env).length, 1, 'continuous actions must not postpone the first save indefinitely');
  assert.equal(activePuts(env)[0].body.actions.length, 5);
  assert.equal(manager.gameDirty, false);
  assert.ok(env.statuses.every(status => !status.message.includes('Saving') && !status.message.includes('saved.')));
});

test('CAS conflict rebases a compatible local tail without dropping any action', async () => {
  const store = { game: game(session('shared'), [['move', 3]], 1, state(8, 4)) };
  let puts = 0;
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT' && ++puts === 1) {
      store.game = game(session('shared'), [['move', 3], ['move', 0]], 2, state(16, 8));
      return Promise.resolve(response({ message: 'Conflict', game: store.game }, 409));
    }
  } });
  const local = localGame(game(session('shared'), [['move', 3], ['move', 0], ['move', 1]], 1, state(32, 8, 999)));
  await env.manager.prepareGame(local);
  const changes = [];
  env.manager.onGameChange((board, message) => changes.push({ board, message }));
  await env.manager.flushGame();
  assert.equal(env.manager.actions.length, 3);
  assert.equal(env.manager.revision, 2);
  assert.equal(env.manager.activeState.randomState, 999);
  assert.equal(changes.length, 0);
  await env.advance(0);
  assert.equal(activePuts(env).length, 2);
  assert.equal(activePuts(env)[1].body.revision, 2);
  assert.deepEqual(activePuts(env)[1].body.actions, local.actions);
  assert.equal(env.manager.gameDirty, false);
});

test('divergent conflict restores the authoritative game but preserves the old score proof', async () => {
  const store = { game: game(session('shared'), [['move', 3]], 1, state(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') return Promise.resolve(response({ message: 'Conflict', game: store.game }, 409));
  } });
  await env.manager.prepareGame(localGame(store.game));
  move(env.manager, 0, 1400, 256);
  env.manager.setGameState(state(1400, 256, 111));
  store.game = game(session('shared'), [['move', 3], ['move', 1]], 2, state(1300, 128, 222));
  const changes = [];
  env.manager.onGameChange((board, message) => {
    assert.equal(env.manager.revision, 2);
    changes.push({ board, message });
  });
  await env.manager.flushGame();
  assert.equal(changes.length, 1);
  assert.match(changes[0].message, /changed in another browser/);
  assert.equal(changes[0].board.randomState, 222);
  assert.deepEqual(plain(env.manager.actions), store.game.actions);
  assert.deepEqual(env.pending()[0].actions, [['move', 3], ['move', 0]]);
  assert.equal(JSON.parse(env.shared.get(env.manager.local.gameStateKey + '.superseded')).score, 1400);
});

test('focus refresh loads a newer server history and keeps a compatible unsent local tail', async () => {
  const store = { game: game(session('shared'), [['move', 3]], 1, state(8, 4)) };
  const env = load({ gameStore: store });
  await env.manager.prepareGame(null);
  const changes = [];
  env.manager.onGameChange((board, message) => changes.push({ board, message }));
  store.game = game(session('shared'), [['move', 3], ['move', 0]], 2, state(16, 8, 222));
  env.emitWindow('focus');
  await settle();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].message, '');
  assert.equal(env.manager.activeState.randomState, 222);
  move(env.manager, 1, 24, 8);
  env.manager.setGameState(state(24, 8, 333));
  await env.manager.refreshGame();
  assert.equal(env.manager.actions.length, 3);
  assert.equal(env.manager.activeState.randomState, 333);
  assert.equal(changes.length, 1);
});

test('an old PUT response cannot restore the game replaced by an explicit restart', async () => {
  const old = deferred();
  const env = load({ fetch(call) { if (call.init.method === 'PUT') return old.promise; } });
  const manager = await start(env);
  const oldSession = plain(manager.session);
  move(manager, 3, 8, 4);
  manager.setGameState(state(8, 4));
  const pending = manager.flushGame();
  await settle();
  manager.startNewGame();
  await manager.prepareGame(null);
  assert.notEqual(manager.session.token, oldSession.token);
  const replacement = manager.session.token;
  old.resolve(response({ game: game(oldSession, [['move', 3]], 1, state(8, 4)) }));
  await pending;
  assert.equal(manager.session.token, replacement);
  assert.equal(manager.actions.length, 0);
  assert.equal(manager.gamePaused, false);
});

test('a stale conflict refresh failure cannot pause a newly started game', async () => {
  const conflictRead = deferred();
  let reads = 0;
  const env = load({ fetch(call) {
    if (call.url.endsWith('/games') && call.init.method === 'GET' && ++reads === 2) return conflictRead.promise;
    if (call.init.method === 'PUT') return Promise.resolve(response({ message: 'Conflict', game: null }, 409));
  } });
  const manager = await start(env);
  move(manager, 3, 8, 4);
  const pending = manager.flushGame();
  await settle();
  manager.startNewGame();
  await manager.prepareGame(null);
  conflictRead.resolve(response({ message: 'Expired login' }, 403));
  await pending;
  assert.equal(manager.gamePaused, false);
  assert.equal(manager.session.token, 'session-2');
  assert.ok(!String(env.root.dataset.storageMessage || '').includes('Sign in again'));
});

test('offline startup retains a valid local board while failed authentication pauses saves', async () => {
  const local = localGame(game(session('offline'), [['move', 3]], 3, state(1200, 128, 999)));
  const env = load({ fetch(call) {
    if (call.url.endsWith('/games')) return Promise.reject(new TypeError('offline'));
  } });
  assert.equal((await env.manager.prepareGame(local)).randomState, 999);
  assert.equal(env.manager.session.token, 'offline');
  assert.equal(env.manager.actions.length, 1);
  assert.equal(env.manager.gameDirty, true);
  const auth = load({ fetch(call) {
    if (call.url.endsWith('/games')) return Promise.resolve(response({ message: 'CSRF check failed' }, 412));
  } });
  assert.equal((await auth.manager.prepareGame(local)).score, 1200);
  assert.equal(auth.manager.gamePaused, true);
  await auth.advance(60000);
  assert.equal(activePuts(auth).length, 0);
});

test('an expired local adoption obtains a fresh server game and notifies the board', async () => {
  const env = load({ fetch(call) {
    if (call.init.method === 'PUT') return Promise.resolve(response({ message: 'Expired game' }, 400));
  } });
  const local = localGame(game(session('expired'), [['move', 3]], 0, state(1200, 128)));
  const changes = [];
  env.manager.onGameChange((board, message) => changes.push({ board, message }));
  await env.manager.prepareGame(local);
  await env.manager.flushGame();
  assert.equal(env.manager.session.token, 'session-1');
  assert.equal(env.manager.gamePaused, false);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].board.score, 0);
  assert.equal(JSON.parse(env.shared.get(env.manager.local.gameStateKey + '.superseded')).session.token, 'expired');
});

test('game over sync retains the terminal board and does not create a replacement game', async () => {
  const env = load();
  const manager = await start(env);
  move(manager, 3, 8, 4);
  const terminal = Object.assign(state(8, 4), { over: true, bonuses: { undo: 0, swap: 0, remove: 0 } });
  manager.setGameState(terminal);
  await manager.clearGameState();
  await settle();
  assert.equal(manager.getGameState().over, true);
  assert.equal(env.gameStore.game.state.over, true);
  assert.equal(env.calls.filter(call => call.url.endsWith('/games') && call.init.method === 'POST').length, 1);
});

test('a late GET with no active game cannot reset a newer acknowledged revision', async () => {
  const oldRead = deferred();
  let reads = 0;
  const env = load({ serverGame: game(session('shared')), fetch(call) {
    if (call.url.endsWith('/games') && call.init.method === 'GET' && ++reads === 2) return oldRead.promise;
  } });
  await env.manager.prepareGame(null);
  const refreshing = env.manager.refreshGame();
  await settle();
  move(env.manager, 3, 8, 4);
  env.manager.setGameState(state(8, 4, 333));
  await env.manager.flushGame();
  assert.equal(env.manager.revision, 1);
  oldRead.resolve(response({ game: null }));
  await refreshing;
  assert.equal(env.manager.revision, 1);
  assert.equal(env.manager.gameDirty, false);
  await env.advance(1000);
  assert.equal(activePuts(env).length, 1);
});

test('an in-flight active snapshot leaves its newer local tail queued without repainting the older board', async () => {
  const first = deferred();
  let puts = 0;
  const env = load({ serverGame: game(session('shared')), fetch(call) {
    if (call.init.method === 'PUT' && ++puts === 1) return first.promise;
  } });
  await env.manager.prepareGame(null);
  const changes = [];
  env.manager.onGameChange(board => changes.push(board));
  move(env.manager, 3, 8, 4);
  env.manager.setGameState(state(8, 4, 111));
  const pending = env.manager.flushGame();
  await settle();
  move(env.manager, 0, 16, 8);
  env.manager.setGameState(state(16, 8, 222));
  assert.equal(env.manager.flushGame(), pending);
  const accepted = game(session('shared'), [['move', 3]], 1, state(8, 4, 111));
  env.gameStore.game = accepted;
  first.resolve(response({ game: accepted }));
  await pending;
  assert.equal(env.manager.activeState.randomState, 222);
  assert.equal(changes.length, 0);
  assert.equal(env.manager.gameDirty, true);
  await env.advance(0);
  assert.deepEqual(activePuts(env)[1].body, { session: 'shared', actions: [['move', 3], ['move', 0]], revision: 1 });
  assert.equal(env.manager.revision, 2);
  assert.equal(env.manager.gameDirty, false);
  assert.equal(changes.length, 0);
});

const v2Session = (token, previousToken, seed = 123) => ({ token, previousToken, seed, version: 2 });
const v2Board = (score, tile, rng = 99) => Object.assign(state(score, tile, rng), { pendingBonuses: { undo: 0, swap: 0, remove: 0 } });

test('version 2 sessions and pending bonuses survive validation and activation', async () => {
  const board = v2Board(128, 128);
  board.pendingBonuses.undo = 1;
  const canonical = game(v2Session('version-two'), [['move', 3]], 2, board);
  const env = load({ serverGame: canonical });
  const restored = await env.manager.prepareGame(null);
  assert.equal(env.manager.session.version, 2);
  assert.equal(restored.pendingBonuses.undo, 1);
  assert.equal(env.manager.validLocalGame(restored), true);
  assert.equal(env.manager.validLocalGame(Object.assign({}, restored, { pendingBonuses: { undo: 2, swap: 0, remove: 0 } })), false);
  assert.equal(env.manager.sameGameState(restored, Object.assign({}, restored, { pendingBonuses: { undo: 0, swap: 0, remove: 0 } })), false);
});

test('startup upgrades a compatible offline version 1 tail using the complete verified version 2 replay', async () => {
  const old = localGame(game(session('old-v1'), [['move', 3], ['move', 0], ['move', 1]], 3, state(1300, 128, 555)));
  const upgraded = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 4, v2Board(1200, 128, 111));
  const env = load({ serverGame: upgraded, fetch(call) {
    if (call.init.method === 'PUT') return Promise.resolve(response({ game: game(upgraded.session, call.body.actions, 5, v2Board(1300, 128, 555)) }));
  } });
  // A pending version-1 record must remain independently verifiable.
  env.shared.set(env.manager.queueKey + '.job.old-proof', JSON.stringify({ id: 'old-proof', session: 'old-v1', actions: old.actions,
    score: 1300, bestTile: 128, attempts: 0, nextAttempt: 0, blocked: false }));
  const restored = await env.manager.prepareGame(old);
  assert.deepEqual(activePuts(env)[0].body, { session: 'new-v2', actions: old.actions, revision: 4 });
  assert.equal(restored.session.version, 2);
  assert.equal(restored.randomState, 555);
  assert.equal(restored.revision, 5);
  assert.deepEqual(restored.pendingBonuses, { undo: 0, swap: 0, remove: 0 });
  assert.equal(env.manager.gameTransitioning, false);
  assert.deepEqual(env.pending()[0].actions, old.actions);
  assert.equal(env.pending()[0].session, 'old-v1');
});

test('equal version 1 histories load the upgraded server state without another PUT', async () => {
  const history = [['move', 3]];
  const board = v2Board(1200, 128);
  board.pendingBonuses.undo = 1;
  const env = load({ serverGame: game(v2Session('new-v2', 'old-v1'), history, 3, board) });
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 2, state(1200, 128))));
  assert.equal(restored.pendingBonuses.undo, 1);
  assert.equal(restored.session.version, 2);
  assert.equal(activePuts(env).length, 0);
});

test('background promotion freezes actions and keeps the refresh busy until the full replay arrives', async () => {
  const promotion = deferred();
  const store = { game: game(session('old-v1'), [['move', 3]], 1, state(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) { if (call.init.method === 'PUT') return promotion.promise; } });
  await env.manager.prepareGame(null);
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(state(1300, 128, 555));
  store.game = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  const changes = [];
  env.manager.onGameChange((board, message) => changes.push({ board, message }));
  const refreshing = env.manager.refreshGame();
  await settle();
  assert.equal(env.manager.gameTransitioning, true);
  assert.equal(env.manager.session.version, 1);
  assert.equal(env.manager.gameRefreshInFlight, refreshing);
  assert.throws(() => env.manager.recordAction(['move', 1]), /being updated/);
  promotion.resolve(response({ game: game(store.game.session, [['move', 3], ['move', 0]], 3, v2Board(1300, 128, 555)) }));
  await refreshing;
  assert.equal(env.manager.session.version, 2);
  assert.equal(env.manager.gameTransitioning, false);
  assert.equal(env.manager.gameRefreshInFlight, null);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].message, '');
  assert.deepEqual(changes[0].board.actions, [['move', 3], ['move', 0]]);
});

test('an old-token PUT conflict promotes the entire offline tail instead of discarding it', async () => {
  const store = { game: game(session('old-v1'), [['move', 3]], 1, state(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') {
      if (call.body.session === 'old-v1') return Promise.resolve(response({ message: 'Upgraded', game: store.game }, 409));
      return Promise.resolve(response({ game: game(store.game.session, call.body.actions, 3, v2Board(1300, 128, 555)) }));
    }
  } });
  await env.manager.prepareGame(null);
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(state(1300, 128, 555));
  store.game = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  await env.manager.flushGame();
  assert.deepEqual(activePuts(env).map(call => call.body.session), ['old-v1', 'new-v2']);
  assert.equal(activePuts(env)[1].body.actions.length, 2);
  assert.equal(env.manager.session.version, 2);
  assert.equal(env.manager.actions.length, 2);
  assert.equal(env.manager.gameDirty, false);
  assert.equal(env.pending()[0].session, 'old-v1');
});

test('promotion rebases a compatible CAS revision conflict before applying version 2', async () => {
  const store = { game: game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128)) };
  let puts = 0;
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') {
      if (++puts === 1) {
        store.game = game(store.game.session, [['move', 3], ['move', 0]], 3, v2Board(1250, 128));
        return Promise.resolve(response({ message: 'Revision changed', game: store.game }, 409));
      }
      return Promise.resolve(response({ game: game(store.game.session, call.body.actions, 4, v2Board(1300, 128, 555)) }));
    }
  } });
  const history = [['move', 3], ['move', 0], ['move', 1]];
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128, 555))));
  assert.equal(activePuts(env).length, 2);
  assert.equal(activePuts(env)[1].body.revision, 3);
  assert.deepEqual(restored.actions, history);
  assert.equal(restored.revision, 4);
});

test('repeated promotion conflicts retain the local version 1 tail and release the freeze', async () => {
  const upgraded = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  const env = load({ serverGame: upgraded, fetch(call) {
    if (call.init.method === 'PUT') return Promise.resolve(response({ message: 'Conflict', game: upgraded }, 409));
  } });
  const history = [['move', 3], ['move', 0]];
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128, 555))));
  assert.equal(activePuts(env).length, 3);
  assert.equal(restored.session.version, 1);
  assert.deepEqual(restored.actions, history);
  assert.equal(restored.randomState, 555);
  assert.equal(env.manager.gameTransitioning, false);
  assert.equal(env.manager.gameDirty, true);
});

test('a network failure during promotion keeps offline version 1 play recoverable', async () => {
  let online = false;
  const upgraded = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  const env = load({ serverGame: upgraded, fetch(call) {
    if (call.init.method === 'PUT') {
      if (!online) return Promise.reject(new TypeError('offline'));
      return Promise.resolve(response({ game: game(upgraded.session, call.body.actions, 3, v2Board(1300, 128, 555)) }));
    }
  } });
  const history = [['move', 3], ['move', 0]];
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128, 555))));
  assert.equal(restored.session.version, 1);
  assert.equal(env.manager.gameTransitioning, false);
  assert.deepEqual(env.manager.getGameState().actions, history);
  online = true;
  env.emitWindow('online');
  await settle();
  await env.advance(0);
  assert.equal(env.manager.session.version, 2);
  assert.deepEqual(plain(env.manager.actions), history);
});

test('New Game invalidates a delayed version upgrade without freezing the replacement', async () => {
  const promotion = deferred();
  const store = { game: game(session('old-v1'), [['move', 3]], 1, state(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') return promotion.promise;
    if (call.init.method === 'POST' && call.url.endsWith('/games') && call.body.restart) {
      return Promise.resolve(response({ game: game(v2Session('fresh-v2'), [], 0, v2Board(0, 2)) }));
    }
  } });
  await env.manager.prepareGame(null);
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(state(1300, 128));
  store.game = game(v2Session('upgraded-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  const refreshing = env.manager.refreshGame();
  await settle();
  assert.equal(env.manager.gameTransitioning, true);
  env.manager.startNewGame();
  await env.manager.prepareGame(null);
  promotion.resolve(response({ game: game(store.game.session, [['move', 3], ['move', 0]], 3, v2Board(1300, 128)) }));
  await refreshing;
  assert.equal(env.manager.session.token, 'fresh-v2');
  assert.equal(env.manager.actions.length, 0);
  assert.equal(env.manager.gameTransitioning, false);
});

test('an unrelated version 2 token or seed cannot adopt an offline version 1 tail', async () => {
  const env = load({ serverGame: game(v2Session('unrelated-v2', 'old-v1', 999), [['move', 3]], 2, v2Board(1200, 128)) });
  const history = [['move', 3], ['move', 0]];
  await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128))));
  assert.equal(activePuts(env).length, 0);
  assert.equal(env.manager.session.token, 'unrelated-v2');
  assert.equal(env.manager.actions.length, 1);
  assert.equal(JSON.parse(env.shared.get(env.manager.local.gameStateKey + '.superseded')).actions.length, 2);
});

test('remote compatible advancement that spends a bonus has a meaningful message', async () => {
  const store = { game: game(session('shared'), [['move', 3]], 1, state(1200, 128)) };
  const env = load({ gameStore: store });
  await env.manager.prepareGame(null);
  const board = Object.assign(state(1200, 128), { bonuses: { undo: 1, swap: 2, remove: 2 } });
  env.manager.setGameState(board);
  const advanced = Object.assign(state(1200, 128), { bonuses: { undo: 0, swap: 2, remove: 2 } });
  store.game = game(session('shared'), [['move', 3], ['undo'], ['move', 3]], 2, advanced);
  const messages = [];
  env.manager.onGameChange((state, message) => messages.push(message));
  await env.manager.refreshGame();
  assert.match(messages[0], /advanced in another browser/);
  assert.equal(env.manager.activeState.bonuses.undo, 0);
});

test('concurrent focus and old-token conflict share one promotion and preserve moves after failure', async () => {
  const focusRead = deferred(), promotion = deferred();
  const store = { game: game(session('old-v1'), [['move', 3]], 1, state(1200, 128)) };
  let reads = 0, promotions = 0;
  const env = load({ gameStore: store, fetch(call) {
    if (call.url.endsWith('/games') && call.init.method === 'GET' && ++reads === 2) return focusRead.promise;
    if (call.init.method === 'PUT') {
      if (call.body.session === 'old-v1') return Promise.resolve(response({ message: 'Upgraded', game: store.game }, 409));
      if (++promotions === 1) return promotion.promise;
      return Promise.resolve(response({ game: game(store.game.session, call.body.actions, 4, v2Board(1400, 128, 333)) }));
    }
  } });
  await env.manager.prepareGame(null);
  const refreshing = env.manager.refreshGame();
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(state(1300, 128, 222));
  store.game = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  const saving = env.manager.flushGame();
  await settle();
  assert.equal(promotions, 1);
  assert.equal(env.manager.gameTransitioning, true);
  focusRead.resolve(response({ game: plain(store.game) }));
  await settle();
  assert.equal(promotions, 1, 'both reconciliation paths must await the same promotion');
  assert.throws(() => env.manager.recordAction(['move', 1]), /being updated/);
  promotion.reject(new TypeError('offline'));
  await Promise.all([refreshing, saving]);
  assert.equal(env.manager.gameTransitioning, false);
  assert.equal(env.manager.session.version, 1);
  move(env.manager, 1, 1400, 128);
  env.manager.setGameState(state(1400, 128, 333));
  env.emitWindow('online');
  await settle();
  assert.equal(promotions, 2);
  assert.equal(env.manager.session.version, 2);
  assert.deepEqual(plain(env.manager.actions), [['move', 3], ['move', 0], ['move', 1]]);
  assert.equal(env.manager.activeState.randomState, 333);
});

test('a diverging promotion CAS winner replaces the live board and retains the old proof', async () => {
  const store = { game: game(session('old-v1'), [['move', 3]], 1, state(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') {
      store.game = game(v2Session('new-v2', 'old-v1'), [['move', 3], ['move', 1]], 3, v2Board(1250, 128, 777));
      return Promise.resolve(response({ message: 'Other moves won', game: store.game }, 409));
    }
  } });
  await env.manager.prepareGame(null);
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(state(1300, 128, 555));
  store.game = game(v2Session('new-v2', 'old-v1'), [['move', 3]], 2, v2Board(1200, 128));
  const messages = [];
  env.manager.onGameChange((board, message) => messages.push(message));
  await env.manager.refreshGame();
  assert.equal(activePuts(env).length, 1);
  assert.deepEqual(plain(env.manager.actions), [['move', 3], ['move', 1]]);
  assert.equal(env.manager.session.version, 2);
  assert.equal(env.manager.activeState.randomState, 777);
  assert.match(messages[0], /changed in another browser/);
  assert.equal(env.pending()[0].session, 'old-v1');
  assert.deepEqual(env.pending()[0].actions, [['move', 3], ['move', 0]]);
  assert.equal(env.manager.gameTransitioning, false);
});

test('normal compatible CAS conflicts back off instead of immediately retrying forever', async () => {
  const canonical = game(session('shared'), [], 0, state(0, 2));
  const env = load({ serverGame: canonical, fetch(call) {
    if (call.init.method === 'PUT') return Promise.resolve(response({ message: 'Conflict', game: canonical }, 409));
  } });
  await env.manager.prepareGame(null);
  move(env.manager, 3, 8, 4);
  env.manager.setGameState(state(8, 4));
  await env.manager.flushGame();
  await env.advance(0);
  assert.equal(activePuts(env).length, 2);
  assert.equal(env.manager.gameDirty, true);
  await env.advance(999);
  assert.equal(activePuts(env).length, 2);
  await env.advance(1);
  assert.equal(activePuts(env).length, 3);
  assert.deepEqual(plain(env.manager.actions), [['move', 3]]);
});

const v3Session = (token, previousToken, cutover = 0, seed = 123) => previousToken === undefined
  ? { token, seed, version: 3 } : { token, previousToken, cutover, seed, version: 3 };

test('native version 3 restores without a pending bank or a promotion request', async () => {
  const env = load({ serverGame: game(v3Session('fresh-v3'), [], 0, state(0, 2)) });
  const restored = await env.manager.prepareGame(null);
  assert.equal(restored.session.version, 3);
  assert.equal(restored.pendingBonuses, undefined);
  assert.equal(env.manager.validLocalGame(restored), true);
  assert.equal(activePuts(env).length, 0);
  assert.equal(env.manager.validLocalGame(Object.assign({}, restored, { pendingBonuses: { undo: 0, swap: 0, remove: 0 } })), false);
});

test('offline version 2 banked actions extend the v3 cutover and preserve their ready counter', async () => {
  const oldHistory = [['move', 3], ['undo'], ['move', 0], ['undo']];
  const oldBoard = v2Board(1200, 128, 555);
  oldBoard.bonuses.undo = 1; // Under v2 the first Undo used a banked refill, then the second spent one.
  const old = localGame(game(v2Session('old-v2'), oldHistory, 1, oldBoard));
  const upgraded = game(v3Session('initial-v3', 'old-v2', 1), [['move', 3]], 2, state(1200, 128));
  const verified = Object.assign(state(1200, 128, 555), { bonuses: { undo: 1, swap: 2, remove: 2 } });
  const env = load({ serverGame: upgraded, fetch(call) {
    if (call.init.method === 'PUT') {
      assert.deepEqual(call.body, { session: 'initial-v3', actions: oldHistory, revision: 2, upgradeFrom: 'old-v2' });
      return Promise.resolve(response({ game: game(v3Session('tail-v3', 'old-v2', 4), oldHistory, 3, verified) }));
    }
  } });
  const restored = await env.manager.prepareGame(old);
  assert.equal(restored.session.version, 3);
  assert.equal(restored.session.cutover, 4);
  assert.equal(restored.bonuses.undo, 1, 'the old full tail is replayed under v2 before switching to v3');
  assert.equal(restored.pendingBonuses, undefined);
  assert.equal(restored.randomState, 555);
  assert.deepEqual(restored.actions, oldHistory);
  assert.equal(env.manager.gameTransitioning, false);
});

test('offline version 1 tails can be promoted directly to a linked version 3 session', async () => {
  const history = [['move', 3], ['move', 0]];
  const upgraded = game(v3Session('initial-v3', 'old-v1', 1), [['move', 3]], 2, state(1200, 128));
  const env = load({ serverGame: upgraded, fetch(call) {
    if (call.init.method === 'PUT') {
      assert.equal(call.body.upgradeFrom, 'old-v1');
      return Promise.resolve(response({ game: game(v3Session('tail-v3', 'old-v1', 2), history, 3, state(1300, 128, 555)) }));
    }
  } });
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128, 555))));
  assert.equal(restored.session.version, 3);
  assert.equal(restored.session.cutover, 2);
  assert.deepEqual(restored.actions, history);
});

test('an offline v1 ancestor tail uses the signed v2 parent and rebases a compatible v3 cutover', async () => {
  const history = [['move', 3], ['move', 0], ['undo']];
  const descendant = (token, cutover) => Object.assign(v3Session(token, 'old-v2', cutover), { ancestorToken: 'old-v1' });
  const store = { game: game(descendant('initial-v3', 1), history.slice(0, 1), 3, state(1200, 128)) };
  const verified = Object.assign(state(1300, 128, 555), { bonuses: { undo: 1, swap: 2, remove: 2 } });
  let puts = 0;
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') {
      assert.equal(call.body.upgradeFrom, 'old-v2', 'the server replays the tail using its signed v2 parent');
      assert.deepEqual(call.body.actions, history, 'the complete offline v1 tail must survive both requests');
      if (++puts === 1) {
        assert.equal(call.body.session, 'initial-v3');
        assert.equal(call.body.revision, 3);
        store.game = game(descendant('rebased-v3', 2), history.slice(0, 2), 4, state(1300, 128));
        return Promise.resolve(response({ message: 'Another old tail was adopted', game: store.game }, 409));
      }
      assert.equal(call.body.session, 'rebased-v3');
      assert.equal(call.body.revision, 4);
      return Promise.resolve(response({ game: game(descendant('full-v3', 3), history, 5, verified) }));
    }
  } });
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128, 555))));
  assert.equal(activePuts(env).length, 2);
  assert.equal(restored.session.version, 3);
  assert.equal(restored.session.previousToken, 'old-v2');
  assert.equal(restored.session.ancestorToken, 'old-v1');
  assert.equal(restored.session.cutover, 3);
  assert.deepEqual(restored.actions, history);
  assert.equal(restored.bonuses.undo, 1);
  assert.equal(restored.pendingBonuses, undefined);
  assert.equal(env.manager.gameTransitioning, false);
});

test('an already played v3 suffix wins over its offline v1 ancestor tail', async () => {
  const history = [['move', 3], ['move', 0], ['undo']];
  const linked = Object.assign(v3Session('v3-with-moves', 'old-v2', 1), { ancestorToken: 'old-v1' });
  const env = load({ serverGame: game(linked, history.slice(0, 2), 4, state(1300, 128, 777)) });
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128, 555))));
  assert.equal(activePuts(env).length, 0);
  assert.equal(restored.session.token, 'v3-with-moves');
  assert.deepEqual(restored.actions, history.slice(0, 2));
  assert.equal(restored.randomState, 777);
  assert.deepEqual(JSON.parse(env.shared.get(env.manager.local.gameStateKey + '.superseded')).actions, history);
});

test('a v3 session with an unrelated parent cannot infer an absent v1 ancestor from the seed', async () => {
  const history = [['move', 3], ['move', 0]];
  const env = load({ serverGame: game(v3Session('unrelated-v3', 'other-v2', 1), history.slice(0, 1), 3, state(1200, 128)) });
  const restored = await env.manager.prepareGame(localGame(game(session('old-v1'), history, 1, state(1300, 128))));
  assert.equal(activePuts(env).length, 0);
  assert.equal(restored.session.token, 'unrelated-v3');
  assert.deepEqual(restored.actions, history.slice(0, 1));
  assert.deepEqual(JSON.parse(env.shared.get(env.manager.local.gameStateKey + '.superseded')).actions, history);
  assert.equal(env.manager.validLocalGame(Object.assign({}, restored, { session: Object.assign({}, restored.session, { ancestorToken: 42 }) })), false);
});

test('an already played v3 suffix wins over an older-rule offline tail without retrying', async () => {
  const oldHistory = [['move', 3], ['undo'], ['move', 0], ['undo']];
  const canonical = game(v3Session('v3-with-moves', 'old-v2', 1), oldHistory.slice(0, 2), 3, state(1200, 128, 777));
  const env = load({ serverGame: canonical });
  const old = localGame(game(v2Session('old-v2'), oldHistory, 1, v2Board(1200, 128, 555)));
  const restored = await env.manager.prepareGame(old);
  assert.equal(activePuts(env).length, 0, 'the cutover cannot move past canonical actions already played under v3');
  assert.equal(restored.actions.length, 2);
  assert.equal(restored.randomState, 777);
  assert.equal(JSON.parse(env.shared.get(env.manager.local.gameStateKey + '.superseded')).actions.length, 4);
});

test('a CAS winner that starts v3 moves stops old-tail promotion after one request', async () => {
  const store = { game: game(v2Session('old-v2'), [['move', 3]], 1, v2Board(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') {
      store.game = game(v3Session('v3-with-moves', 'old-v2', 1), [['move', 3], ['move', 0]], 3, state(1250, 128, 777));
      return Promise.resolve(response({ message: 'Version 3 actions already exist', game: store.game }, 409));
    }
  } });
  await env.manager.prepareGame(null);
  move(env.manager, 0, 1250, 128);
  move(env.manager, 1, 1300, 128);
  env.manager.setGameState(v2Board(1300, 128, 555));
  store.game = game(v3Session('initial-v3', 'old-v2', 1), [['move', 3]], 2, state(1200, 128));
  const messages = [];
  env.manager.onGameChange((board, message) => messages.push(message));
  await env.manager.refreshGame();
  assert.equal(activePuts(env).length, 1);
  assert.equal(env.manager.session.version, 3);
  assert.equal(env.manager.actions.length, 2);
  assert.match(messages[0], /changed in another browser/);
  assert.equal(env.manager.gameTransitioning, false);
  assert.deepEqual(env.pending()[0].actions, [['move', 3], ['move', 0], ['move', 1]]);
});

test('a compatible v3 cutover CAS extension rebases both the signed token and revision', async () => {
  const history = [['move', 3], ['move', 0], ['move', 1]];
  const store = { game: game(v3Session('v3-cutover-one', 'old-v2', 1), history.slice(0, 1), 2, state(1200, 128)) };
  let puts = 0;
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') {
      if (++puts === 1) {
        store.game = game(v3Session('v3-cutover-two', 'old-v2', 2), history.slice(0, 2), 3, state(1250, 128));
        return Promise.resolve(response({ message: 'Other offline tail was adopted', game: store.game }, 409));
      }
      assert.deepEqual(call.body, { session: 'v3-cutover-two', actions: history, revision: 3, upgradeFrom: 'old-v2' });
      return Promise.resolve(response({ game: game(v3Session('v3-cutover-three', 'old-v2', 3), history, 4, state(1300, 128, 555)) }));
    }
  } });
  const restored = await env.manager.prepareGame(localGame(game(v2Session('old-v2'), history, 1, v2Board(1300, 128, 555))));
  assert.equal(activePuts(env).length, 2);
  assert.equal(restored.session.cutover, 3);
  assert.equal(restored.revision, 4);
  assert.equal(restored.randomState, 555);
});

test('concurrent reconciliations share a v3 promotion and freeze until all old-rule actions are verified', async () => {
  const focusRead = deferred(), promotion = deferred();
  const store = { game: game(v2Session('old-v2'), [['move', 3]], 1, v2Board(1200, 128)) };
  let reads = 0, promotions = 0;
  const env = load({ gameStore: store, fetch(call) {
    if (call.url.endsWith('/games') && call.init.method === 'GET' && ++reads === 2) return focusRead.promise;
    if (call.init.method === 'PUT') {
      if (call.body.session === 'old-v2') return Promise.resolve(response({ message: 'Upgraded', game: store.game }, 409));
      promotions++;
      assert.equal(call.body.upgradeFrom, 'old-v2');
      return promotion.promise;
    }
  } });
  await env.manager.prepareGame(null);
  const refreshing = env.manager.refreshGame();
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(v2Board(1300, 128, 555));
  store.game = game(v3Session('initial-v3', 'old-v2', 1), [['move', 3]], 2, state(1200, 128));
  const saving = env.manager.flushGame();
  await settle();
  focusRead.resolve(response({ game: plain(store.game) }));
  await settle();
  assert.equal(promotions, 1);
  assert.equal(env.manager.gameTransitioning, true);
  assert.throws(() => env.manager.recordAction(['undo']), /being updated/);
  promotion.resolve(response({ game: game(v3Session('tail-v3', 'old-v2', 2), [['move', 3], ['move', 0]], 3, state(1300, 128, 555)) }));
  await Promise.all([refreshing, saving]);
  assert.equal(env.manager.session.version, 3);
  assert.equal(env.manager.actions.length, 2);
  assert.equal(env.manager.gameTransitioning, false);
  assert.equal(env.pending()[0].session, 'old-v2');
});

test('New Game supersedes a delayed v3 cutover extension without changing the new history', async () => {
  const promotion = deferred();
  const store = { game: game(v2Session('old-v2'), [['move', 3]], 1, v2Board(1200, 128)) };
  const env = load({ gameStore: store, fetch(call) {
    if (call.init.method === 'PUT') return promotion.promise;
    if (call.init.method === 'POST' && call.url.endsWith('/games') && call.body.restart) {
      return Promise.resolve(response({ game: game(v3Session('fresh-v3'), [], 0, state(0, 2)) }));
    }
  } });
  await env.manager.prepareGame(null);
  move(env.manager, 0, 1300, 128);
  env.manager.setGameState(v2Board(1300, 128, 555));
  store.game = game(v3Session('initial-v3', 'old-v2', 1), [['move', 3]], 2, state(1200, 128));
  const refreshing = env.manager.refreshGame();
  await settle();
  env.manager.startNewGame();
  await env.manager.prepareGame(null);
  promotion.resolve(response({ game: game(v3Session('tail-v3', 'old-v2', 2), [['move', 3], ['move', 0]], 3, state(1300, 128, 555)) }));
  await refreshing;
  assert.equal(env.manager.session.token, 'fresh-v3');
  assert.equal(env.manager.session.version, 3);
  assert.equal(env.manager.actions.length, 0);
  assert.equal(env.manager.gameTransitioning, false);
});

test('v4 refuses an ancestor tail after its signed v3 parent already played newer rules', async () => {
  const session4 = { token: 'v4-after-played-v3', seed: 123, version: 4,
    previousToken: 'signed-v3', ancestorTokens: ['signed-v2'], cutover: 2, previousCutover: 1 };
  const history = [['move', 3], ['move', 0], ['move', 1]];
  const canonical = game(session4, history.slice(0, 2), 8, state(32, 8, 777));
  const env = load({ serverGame: canonical });
  const local = localGame(game(v2Session('signed-v2'), history, 7, v2Board(48, 8, 999)));
  const restored = await env.manager.prepareGame(local);
  assert.equal(restored.session.token, session4.token);
  assert.deepEqual(plain(restored.actions), canonical.actions);
  assert.equal(activePuts(env).length, 0, 'the v3 boundary must not move after its own suffix');
});

test('a longer ancestor draft cannot reinterpret a locally played v4 suffix', async () => {
  const session4 = { token: 'v4-with-offline-suffix', seed: 123, version: 4,
    previousToken: 'signed-v3', ancestorTokens: ['signed-v2'], cutover: 1, previousCutover: 1 };
  const history = [['move', 3], ['move', 0], ['move', 1]];
  const canonical = game(session4, history.slice(0, 1), 8, state(8, 4, 111));
  const env = load({ serverGame: canonical });
  const local4 = localGame(game(session4, history.slice(0, 2), 8, state(24, 8, 777)));
  const ancestor = localGame(game(v2Session('signed-v2'), history, 7, v2Board(32, 8, 999)));
  env.shared.set(env.manager.draftKey + 'older-version', JSON.stringify({ state: ancestor, savedAt: 100001 }));
  const restored = await env.manager.prepareGame(local4);
  assert.equal(restored.session.token, session4.token);
  assert.deepEqual(plain(restored.actions), local4.actions);
  assert.equal(restored.randomState, 777);
  await env.advance(0);
  assert.equal(activePuts(env)[0].body.upgradeFrom, undefined, 'new v4 actions save as v4 rather than extending old rules');
  assert.deepEqual(activePuts(env)[0].body.actions, local4.actions);
});

test('v5 refuses a tail crossing a played inner boundary even if its immediate parent is unplayed', async () => {
  const session5 = { token:'v5-after-played-v3', seed:123, version:5, previousToken:'signed-v4',
    ancestorTokens:['signed-v3','signed-v2'], ancestorCutovers:[2,1], previousCutover:2, cutover:2 };
  const history=[['move',3],['move',0],['move',1]];
  const canonical=game(session5,history.slice(0,2),8,state(32,8,777));
  const env=load({serverGame:canonical});
  const local=localGame(game(v2Session('signed-v2'),history,7,v2Board(48,8,999)));
  const restored=await env.manager.prepareGame(local);
  assert.equal(restored.session.token,session5.token);
  assert.deepEqual(plain(restored.actions),canonical.actions);
  assert.equal(activePuts(env).length,0);
});

test('two Undo snapshots are validated and a third nested state is rejected', () => {
  const env=load();
  const board=state(32,8);
  const snapshot=()=>({grid:plain(board.grid),score:0,moves:0,won:false,over:false});
  board.previous={...snapshot(),bonus:'remove',previous:{...snapshot(),bonus:'swap'}};
  assert.equal(env.manager.validSavedState(board),true);
  board.previous.previous.previous=snapshot();
  assert.equal(env.manager.validSavedState(board),false);
  delete board.previous.previous.previous;
  board.previous.previous.bonus='undo';
  assert.equal(env.manager.validSavedState(board),false);
});

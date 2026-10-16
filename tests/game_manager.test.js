// Rules of the bonus actions. The browser-side classes are loaded into a vm
// context with stubs for everything that touches the DOM.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function load(savedState, options = {}) {
	const math = Object.create(Math)
	math.random = () => 0.5

	const stored = { state: savedState || null, actions: options.actions || [], scores: [] }
	const ctx = vm.createContext({ console, Math: math, JSON })
	ctx.BonusUI = class { tap() {} update() { ctx.updates = (ctx.updates || 0) + 1 } }
	ctx.InputManager = class {
		constructor() { this.events = {} }
		on(name, handler) { this.events[name] = handler }
	}
	ctx.Actuator = class { actuate() {} continueGame() { ctx.continued = (ctx.continued || 0) + 1 } }
	ctx.Storage = class {
		constructor() {
			this.actions = stored.actions
			if (options.seed) this.session = { seed: options.seed, version: options.version || 1 }
		}
		getBestScore() { return 0 }
		setBestScore() {}
		updateScore(score, stats) { stored.scores.push({ score, ...stats }) }
		recordAction(action) { this.actions.push(JSON.parse(JSON.stringify(action))) }
		getGameState() { return stored.state }
		setGameState(s) { stored.state = JSON.parse(JSON.stringify(s)) }
		clearGameState() { stored.state = null }
	}
	if (options.prepareGame) ctx.Storage.prototype.prepareGame = options.prepareGame
	if (options.sharedGame) {
		ctx.Storage.prototype.onGameChange = function (callback) { stored.remoteChange = callback }
		ctx.Storage.prototype.startNewGame = function () {
			stored.restarts = (stored.restarts || 0) + 1
			stored.state = null
			this.gameTransitioning = false
		}
		ctx.BonusUI.prototype.cancel = function () { stored.selectionCancelled = true }
	}
	for (const file of ['grid', 'tile', 'seeded_random', 'game_manager']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), ctx)
	}
	const game = vm.runInContext('new GameManager(4, InputManager, Actuator, Storage)', ctx)
	return { game, ctx, stored }
}

// rows[y][x]; 0 = empty
function setBoard(env, rows) {
	const { game, ctx } = env
	game.grid = new ctx.Grid(4)
	rows.forEach((row, y) => row.forEach((v, x) => {
		if (v) game.grid.insertTile(new ctx.Tile({ x, y }, v))
	}))
	game.over = false
	game.won = false
	game.previous = null
}

function board(game) {
	const rows = [0, 1, 2, 3].map(() => [0, 0, 0, 0])
	game.grid.eachCell((x, y, t) => { if (t) rows[y][x] = t.value })
	return rows
}

const LEFT = 3
// full board; moving right fills the only gap with a 2 and nothing can merge any more
const ONE_MOVE_FROM_STUCK = [[8, 2, 8, 2], [2, 8, 2, 8], [4, 16, 4, 16], [32, 64, 128, 0]]
const EMPTY = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
const withRow = (y, row) => EMPTY.map((r, i) => (i === y ? row : r))
const MILESTONES = [[128, 'undo'], [256, 'swap'], [512, 'remove']]
const copy = value => JSON.parse(JSON.stringify(value))

function spendBonus(game, type) {
	if (type === 'undo') return game.undo()
	const tiles = game.grid.cells.flat().filter(Boolean)
	if (type === 'remove') return game.removeTilesOfValue(tiles[0].value)
	const first = tiles[0]
	const second = tiles.find(tile => tile.value !== first.value)
	assert.ok(second, 'a successful swap needs two different values')
	return game.swapTiles({ x: first.x, y: first.y }, { x: second.x, y: second.y })
}

test('a new game starts with two charges of each bonus', () => {
	const { game } = load()
	assert.deepStrictEqual(JSON.parse(JSON.stringify(game.bonuses)), { undo: 2, swap: 2, remove: 2 })
})

test('undo is not available before the first move', () => {
	const env = load()
	assert.strictEqual(env.game.canUndo(), false)
	assert.strictEqual(env.game.undo(), false)
})

test('undo restores board, score and moves, and uses a charge', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [2, 2, 4, 0]))
	game.score = 10
	game.moves = 5
	const before = board(game)

	game.move(LEFT)
	assert.notDeepStrictEqual(board(game), before)
	assert.ok(game.canUndo())

	assert.ok(game.undo())
	assert.deepStrictEqual(board(game), before)
	assert.strictEqual(game.score, 10)
	assert.strictEqual(game.moves, 5)
	assert.strictEqual(game.bonuses.undo, 1)
	assert.strictEqual(env.ctx.continued, 1)
})

test('only the last move can be undone', () => {
	const env = load()
	setBoard(env, withRow(0, [2, 0, 0, 0]))
	env.game.move(2) // down
	env.game.undo()
	assert.strictEqual(env.game.canUndo(), false)
	assert.strictEqual(env.game.undo(), false)
	assert.strictEqual(env.game.bonuses.undo, 1)
})

test('undo with no charges left does nothing', () => {
	const env = load()
	setBoard(env, withRow(0, [2, 0, 0, 0]))
	env.game.move(2)
	env.game.bonuses.undo = 0
	assert.strictEqual(env.game.undo(), false)
})

test('undo takes the game out of game over', () => {
	const env = load()
	const { game } = env
	setBoard(env, ONE_MOVE_FROM_STUCK)
	game.move(1)
	assert.ok(game.over, 'precondition: game over')
	assert.ok(game.undo())
	assert.strictEqual(game.over, false)
	assert.strictEqual(game.isGameTerminated(), false)
})

test('undo takes back a win', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [1024, 1024, 0, 0]))
	game.move(LEFT)
	assert.ok(game.won)
	game.undo()
	assert.strictEqual(game.won, false)
})

test('first 128 / 256 / 512 give one charge of undo / swap / remove', () => {
	for (const [value, type] of [[128, 'undo'], [256, 'swap'], [512, 'remove']]) {
		const env = load()
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.bonuses[type] = 1
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], 2, type)
		assert.ok(env.game.reached[value])
	}
})

test('charges never exceed two', () => {
	const env = load()
	setBoard(env, withRow(0, [64, 64, 0, 0]))
	env.game.move(LEFT)
	assert.strictEqual(env.game.bonuses.undo, 2)
})

test('v1 awards a charge only once per game for each tile', () => {
	const env = load(null, { seed: 42, version: 1 })
	const { game } = env
	game.bonuses.undo = 0
	setBoard(env, withRow(0, [64, 64, 0, 0]))
	game.move(LEFT)
	assert.strictEqual(game.bonuses.undo, 1)

	game.bonuses.undo = 0
	setBoard(env, withRow(1, [64, 64, 0, 0]))
	game.move(LEFT)
	assert.strictEqual(game.bonuses.undo, 0, 'second 128 earns nothing')
})

test('v1 undo and redo of a merge does not farm charges', () => {
	const env = load(null, { seed: 42, version: 1 })
	const { game } = env
	game.bonuses.undo = 1
	setBoard(env, withRow(0, [64, 64, 0, 0]))
	game.move(LEFT) // 128 made: 1 -> 2
	assert.strictEqual(game.bonuses.undo, 2)
	game.undo() // 2 -> 1
	assert.strictEqual(game.bonuses.undo, 1)
	game.move(LEFT) // 128 again: no new charge
	assert.strictEqual(game.bonuses.undo, 1)
	game.undo()
	assert.strictEqual(game.bonuses.undo, 0)
	assert.strictEqual(game.undo(), false)
})

test('new local games use v5 while versioned sessions retain their original rules', () => {
	const local = load().game
	assert.strictEqual(local.rulesVersion, 5)
	assert.strictEqual(Object.hasOwn(local.serialize(), 'pendingBonuses'), false)
	const legacy = load(null, { seed: 42 }).game
	assert.strictEqual(legacy.rulesVersion, 1)
	assert.strictEqual(Object.hasOwn(legacy.serialize(), 'pendingBonuses'), false)
	delete legacy.storageManager.session.version
	legacy.initializeState(null)
	assert.strictEqual(legacy.rulesVersion, 1)
	assert.strictEqual(Object.hasOwn(legacy.serialize(), 'pendingBonuses'), false)
	const banked = load(null, { seed: 42, version: 2 }).game
	assert.strictEqual(banked.rulesVersion, 2)
	assert.deepStrictEqual(copy(banked.serialize().pendingBonuses), { undo: 0, swap: 0, remove: 0 })
	assert.strictEqual(load(null, { seed: 42, version: 3 }).game.rulesVersion, 3)
	assert.strictEqual(load(null, { seed: 42, version: 4 }).game.rulesVersion, 4)
})

test('v2 banks each first milestone at the full cap and redeems it on one successful use', () => {
	for (const [value, type] of MILESTONES) {
		const env = load(null, { seed: 42, version: 2 })
		const { game } = env
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		game.move(LEFT)
		assert.strictEqual(game.bonuses[type], 2, type + ': cap is unchanged')
		assert.strictEqual(game.pendingBonuses[type], 1, type + ': first milestone is banked')
		assert.strictEqual(game.reached[value], true)
		assert.strictEqual(spendBonus(game, type), true)
		assert.strictEqual(game.bonuses[type], 2, type + ': use spends one charge and redeems the banked charge')
		assert.strictEqual(game.pendingBonuses[type], 0)
		if (type === 'undo') game.move(LEFT)
		assert.strictEqual(spendBonus(game, type), true)
		assert.strictEqual(game.bonuses[type], 1, type + ': the next use spends a charge normally')
		assert.strictEqual(game.pendingBonuses[type], 0)
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		game.move(LEFT)
		assert.strictEqual(game.bonuses[type], 1, type + ': repeating the milestone cannot refill the bank')
		assert.strictEqual(game.pendingBonuses[type], 0)
	}
})

test('v1 preserves the original capped milestone behavior and restoration shape', () => {
	for (const [value, type] of MILESTONES) {
		const env = load(null, { seed: 42, version: 1 })
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], 2)
		assert.strictEqual(Object.hasOwn(env.stored.state, 'pendingBonuses'), false)
		assert.strictEqual(spendBonus(env.game, type), true)
		assert.strictEqual(env.game.bonuses[type], 1, type + ': v1 discards an award earned at the cap')
		const resumed = load(env.stored.state, { seed: 42, version: 1, actions: copy(env.stored.actions) })
		setBoard(resumed, withRow(0, [value / 2, value / 2, 0, 0]))
		resumed.game.move(LEFT)
		assert.strictEqual(resumed.game.bonuses[type], 1)
		assert.strictEqual(Object.hasOwn(resumed.stored.state, 'pendingBonuses'), false)
	}
})

test('both rules versions grant an immediate first award with capacity and never grant a second one', () => {
	for (const version of [1, 2]) for (const [value, type] of MILESTONES) for (const charges of [0, 1]) {
		const env = load(null, { seed: 42, version })
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.bonuses[type] = charges
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], charges + 1)
		if (version === 2) assert.strictEqual(env.game.pendingBonuses[type], 0)
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], charges + 1)
		if (version === 2) assert.strictEqual(env.game.pendingBonuses[type], 0)
	}
})

test('v2 full-cap 128, Undo, redo and Undo uses the banked charge exactly once across reloads', () => {
	let env = load(null, { seed: 42, version: 2 })
	setBoard(env, withRow(0, [64, 64, 0, 0]))
	env.game.move(LEFT)
	assert.strictEqual(env.game.pendingBonuses.undo, 1)
	env = load(env.stored.state, { seed: 42, version: 2, actions: copy(env.stored.actions) })
	assert.strictEqual(env.game.pendingBonuses.undo, 1)
	assert.ok(env.game.undo())
	assert.strictEqual(env.game.bonuses.undo, 2)
	assert.strictEqual(env.game.pendingBonuses.undo, 0)
	assert.deepStrictEqual(board(env.game)[0], [64, 64, 0, 0])
	assert.strictEqual(env.game.reached[128], true)
	env = load(env.stored.state, { seed: 42, version: 2, actions: copy(env.stored.actions) })
	env.game.move(LEFT)
	assert.strictEqual(env.game.bonuses.undo, 2)
	assert.strictEqual(env.game.pendingBonuses.undo, 0)
	assert.ok(env.game.undo())
	assert.strictEqual(env.game.bonuses.undo, 1)
	assert.strictEqual(env.game.pendingBonuses.undo, 0)
	assert.deepStrictEqual(env.stored.actions, [['move', LEFT], ['undo'], ['move', LEFT], ['undo']])
})

test('v2 reload and remote restoration retain banked awards for all three bonus types', () => {
	for (const [value, type] of MILESTONES) {
		const source = load(null, { seed: 42, version: 2 })
		setBoard(source, withRow(0, [value / 2, value / 2, 0, 0]))
		source.game.move(LEFT)
		const saved = copy(source.stored.state)
		const resumed = load(copy(saved), { seed: 42, version: 2, actions: copy(source.stored.actions) })
		const remote = load(null, { seed: 42, version: 2, sharedGame: true })
		remote.stored.remoteChange(copy(saved))
		for (const env of [resumed, remote]) {
			assert.strictEqual(env.game.pendingBonuses[type], 1)
			assert.strictEqual(env.game.reached[value], true)
			assert.strictEqual(spendBonus(env.game, type), true)
			assert.strictEqual(env.game.bonuses[type], 2)
			assert.strictEqual(env.game.pendingBonuses[type], 0)
		}
		assert.deepStrictEqual(saved, source.stored.state, 'restored games do not mutate the original saved state')
	}
})

test('v2 Undo preserves another bonus type\'s banked award and restart clears all banks', () => {
	const env = load(null, { seed: 42, version: 2 })
	setBoard(env, withRow(0, [256, 256, 0, 0]))
	env.game.move(LEFT)
	assert.strictEqual(env.game.pendingBonuses.remove, 1)
	assert.ok(env.game.undo())
	assert.strictEqual(env.game.bonuses.undo, 1)
	assert.strictEqual(env.game.pendingBonuses.remove, 1)
	assert.strictEqual(env.game.reached[512], true)
	env.game.move(LEFT)
	assert.strictEqual(env.game.pendingBonuses.remove, 1)
	assert.ok(env.game.removeTilesOfValue(512))
	assert.strictEqual(env.game.bonuses.remove, 2)
	assert.strictEqual(env.game.pendingBonuses.remove, 0)
	setBoard(env, withRow(0, [64, 64, 128, 128]))
	env.game.move(LEFT)
	assert.strictEqual(env.game.pendingBonuses.swap, 1)
	env.game.restart()
	assert.deepStrictEqual(copy(env.game.bonuses), { undo: 2, swap: 2, remove: 2 })
	assert.deepStrictEqual(copy(env.game.pendingBonuses), { undo: 0, swap: 0, remove: 0 })
	assert.deepStrictEqual(copy(env.game.reached), {})
})

test('v2 rejected bonus actions and a no-op move do not consume banked awards', () => {
	const env = load(null, { seed: 42, version: 2 })
	setBoard(env, [[64, 64, 128, 128], [256, 256, 2, 4], ...EMPTY.slice(2)])
	env.game.move(LEFT)
	assert.deepStrictEqual(copy(env.game.pendingBonuses), { undo: 1, swap: 1, remove: 1 })
	setBoard(env, withRow(0, [2, 4, 8, 16]))
	const before = copy(env.game.serialize())
	const actions = copy(env.stored.actions)
	env.game.move(LEFT)
	assert.strictEqual(env.game.undo(), false)
	assert.strictEqual(env.game.swapTiles({ x: 0, y: 0 }, { x: 0, y: 0 }), false)
	assert.strictEqual(env.game.swapTiles({ x: 0, y: 0 }, { x: 0, y: 1 }), false)
	assert.strictEqual(env.game.removeTilesOfValue(8192), false)
	assert.deepStrictEqual(copy(env.game.serialize()), before)
	assert.deepStrictEqual(env.stored.actions, actions)
})

test('v3 awards every matching threshold merge even after it was reached, up to the two-charge cap', () => {
	for (const [value, type] of MILESTONES) for (const charges of [0, 1, 2]) {
		const env = load(null, { seed: 42, version: 3 })
		env.game.bonuses = { undo: 0, swap: 0, remove: 0 }
		env.game.bonuses[type] = charges
		env.game.reached[value] = true
		for (let occurrence = 1; occurrence <= 3; occurrence++) {
			setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
			env.game.move(LEFT)
			assert.strictEqual(env.game.bonuses[type], Math.min(2, charges + occurrence), type + ': repeated merge ' + occurrence)
			for (const other of ['undo', 'swap', 'remove'].filter(candidate => candidate !== type)) {
				assert.strictEqual(env.game.bonuses[other], 0, value + ' only rewards ' + type)
			}
			assert.strictEqual(Object.hasOwn(env.stored.state, 'pendingBonuses'), false)
		}
	}
})

test('v3 merging four 64 tiles awards twice in every direction without chaining into 256', () => {
	for (const direction of [0, 1, 2, 3]) for (const charges of [0, 1, 2]) {
		const env = load(null, { seed: 42, version: 3 })
		const rows = EMPTY.map(row => row.slice())
		if (direction === 0 || direction === 2) for (let y = 0; y < 4; y++) rows[y][0] = 64
		else rows[0] = [64, 64, 64, 64]
		setBoard(env, rows)
		env.game.bonuses = { undo: charges, swap: 0, remove: 0 }
		env.game.move(direction)
		const tiles = env.game.grid.cells.flat().filter(Boolean)
		assert.strictEqual(tiles.filter(tile => tile.value === 128).length, 2)
		assert.strictEqual(tiles.filter(tile => tile.value === 256).length, 0)
		assert.deepStrictEqual(copy(env.game.bonuses), { undo: 2, swap: 0, remove: 0 })
		assert.strictEqual(env.game.score, 256)
		assert.strictEqual(env.game.moves, 1)
	}
})

test('v3 drops an award at the full cap and a later successful use spends a charge normally', () => {
	for (const [value, type] of MILESTONES) {
		const env = load(null, { seed: 42, version: 3 })
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], 2)
		assert.strictEqual(Object.hasOwn(env.game.serialize(), 'pendingBonuses'), false)
		assert.strictEqual(spendBonus(env.game, type), true)
		assert.strictEqual(env.game.bonuses[type], 1, type + ': no award is reserved at the cap')
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], 2, type + ': the next real merge replenishes the spent charge')
	}
})

test('v3 Undo and redo each award again below the cap, including after reload', () => {
	for (const charges of [0, 1, 2]) {
		let env = load(null, { seed: 42, version: 3 })
		setBoard(env, withRow(0, [64, 64, 0, 0]))
		env.game.bonuses.undo = charges
		env.game.move(LEFT)
		const awarded = Math.min(2, charges + 1)
		assert.strictEqual(env.game.bonuses.undo, awarded)
		for (let cycle = 0; cycle < 3; cycle++) {
			assert.strictEqual(env.game.undo(), true)
			assert.strictEqual(env.game.bonuses.undo, awarded - 1)
			assert.strictEqual(env.game.reached[128], true)
			env = load(env.stored.state, { seed: 42, version: 3, actions: copy(env.stored.actions) })
			env.game.move(LEFT)
			assert.strictEqual(env.game.bonuses.undo, awarded, 'each redone 128 merge earns a charge again')
			assert.strictEqual(Object.hasOwn(env.stored.state, 'pendingBonuses'), false)
		}
		assert.strictEqual(env.stored.actions.length, 7)
	}
})

test('v3 redo of 256 and 512 earns the corresponding bonus while Undo retains earlier awards', () => {
	for (const [value, type] of MILESTONES.filter(([, type]) => type !== 'undo')) {
		const env = load(null, { seed: 42, version: 3 })
		setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
		env.game.bonuses[type] = 0
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], 1)
		assert.strictEqual(env.game.undo(), true)
		assert.strictEqual(env.game.bonuses[type], 1, 'Undo preserves the earned ' + type + ' charge')
		env.game.move(LEFT)
		assert.strictEqual(env.game.bonuses[type], 2, 'the redone merge earns another ' + type + ' charge')
		assert.strictEqual(env.game.bonuses.undo, 1)
	}
})

test('v3 reload and remote restoration keep repeatable rewards and omit obsolete pending banks', () => {
	for (const [value, type] of MILESTONES) {
		const source = load(null, { seed: 42, version: 3 })
		setBoard(source, withRow(0, [value / 2, value / 2, 0, 0]))
		source.game.bonuses[type] = 0
		source.game.move(LEFT)
		const saved = copy(source.stored.state)
		assert.strictEqual(Object.hasOwn(saved, 'pendingBonuses'), false)
		const restored = copy(saved)
		restored.pendingBonuses = { undo: 1, swap: 1, remove: 1 }
		const resumed = load(restored, { seed: 42, version: 3, actions: copy(source.stored.actions) })
		const remote = load(null, { seed: 42, version: 3, sharedGame: true })
		remote.stored.remoteChange(copy(saved))
		for (const env of [resumed, remote]) {
			assert.strictEqual(env.game.rulesVersion, 3)
			assert.strictEqual(env.game.bonuses[type], 1)
			assert.strictEqual(env.game.reached[value], true)
			assert.strictEqual(Object.hasOwn(env.game.serialize(), 'pendingBonuses'), false)
			setBoard(env, withRow(0, [value / 2, value / 2, 0, 0]))
			env.game.move(LEFT)
			assert.strictEqual(env.game.bonuses[type], 2)
		}
	}
})

test('restart gives fresh charges and forgets reached tiles', () => {
	const env = load()
	const { game } = env
	game.bonuses.undo = 0
	game.reached[128] = true
	game.restart()
	assert.deepStrictEqual(JSON.parse(JSON.stringify(game.bonuses)), { undo: 2, swap: 2, remove: 2 })
	assert.deepStrictEqual(JSON.parse(JSON.stringify(game.reached)), {})
	assert.strictEqual(game.previous, null)
})

test('swap exchanges two tiles, costs a charge, spawns nothing', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [2, 4, 0, 8]))
	const moves = game.moves
	assert.ok(game.swapTiles({ x: 0, y: 0 }, { x: 3, y: 0 }))
	assert.deepStrictEqual(board(game)[0], [8, 4, 0, 2])
	assert.strictEqual(game.bonuses.swap, 1)
	assert.strictEqual(game.moves, moves)
	assert.strictEqual(game.grid.availableCells().length, 13)
	// the tiles know their new positions
	assert.strictEqual(game.grid.cellContent({ x: 0, y: 0 }).x, 0)
	assert.strictEqual(game.grid.cellContent({ x: 3, y: 0 }).x, 3)
})

test('swap rejects equal values, empty cells and the same tile', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [2, 2, 0, 4]))
	assert.strictEqual(game.swapTiles({ x: 0, y: 0 }, { x: 1, y: 0 }), false)
	assert.strictEqual(game.swapTiles({ x: 0, y: 0 }, { x: 2, y: 0 }), false)
	assert.strictEqual(game.swapTiles({ x: 0, y: 0 }, { x: 0, y: 0 }), false)
	assert.strictEqual(game.bonuses.swap, 2)
})

test('legacy v3 swap and remove make undo unavailable until the next move', () => {
	const env = load(null, { seed: 42, version: 3 })
	const { game } = env
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	game.move(2)
	assert.ok(game.canUndo())
	game.swapTiles({ x: 0, y: 3 }, { x: 1, y: 3 })
	assert.strictEqual(game.canUndo(), false)

	game.move(LEFT)
	assert.ok(game.canUndo())
	game.removeTilesOfValue(game.grid.cellContent({ x: 0, y: 3 }).value)
	assert.strictEqual(game.canUndo(), false)
})

test('swap and remove are blocked on the game over screen, undo is not', () => {
	const env = load()
	const { game } = env
	setBoard(env, ONE_MOVE_FROM_STUCK)
	game.move(1)
	assert.ok(game.over)
	assert.strictEqual(game.canUseBonus('swap'), false)
	assert.strictEqual(game.canUseBonus('remove'), false)
	assert.strictEqual(game.removeTilesOfValue(2), false)
	assert.strictEqual(game.canUseBonus('undo'), true)
})

test('a swap that would leave no moves is refused and costs nothing', () => {
	const env = load()
	const { game } = env
	// the only equal neighbours are the two 2s at the top left; swapping one away would lock the board
	const rows = [[2, 2, 4, 8], [16, 32, 64, 128], [256, 512, 1024, 2048], [4096, 8192, 16384, 32768]]
	setBoard(env, rows)
	assert.ok(game.movesAvailable())
	assert.strictEqual(game.swapTiles({ x: 0, y: 0 }, { x: 3, y: 2 }), false)
	assert.deepStrictEqual(board(game), rows)
	assert.strictEqual(game.over, false)
	assert.strictEqual(game.bonuses.swap, 2)
	// tile objects still know where they are
	game.grid.eachCell((x, y, t) => { assert.strictEqual(t.x, x); assert.strictEqual(t.y, y) })
	// a harmless swap on the same board still works
	assert.ok(game.swapTiles({ x: 2, y: 0 }, { x: 3, y: 0 }))
})

test('remove deletes every tile with that value only', () => {
	const env = load()
	const { game } = env
	setBoard(env, [[2, 4, 2, 0], [0, 2, 8, 4], [0, 0, 0, 0], [2, 0, 0, 0]])
	const moves = game.moves
	assert.ok(game.removeTilesOfValue(2))
	assert.deepStrictEqual(board(game), [[0, 4, 0, 0], [0, 0, 8, 4], [0, 0, 0, 0], [0, 0, 0, 0]])
	assert.strictEqual(game.bonuses.remove, 1)
	assert.strictEqual(game.moves, moves, 'remove is not a move')
})

test('remove of a value that is not there changes nothing', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	assert.strictEqual(game.removeTilesOfValue(16), false)
	assert.strictEqual(game.bonuses.remove, 2)
})

test('removing the last tiles never leaves an empty board', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [2, 2, 0, 0]))
	assert.ok(game.removeTilesOfValue(2))
	assert.strictEqual(game.grid.availableCells().length, 14)
})

test('bonuses and the undo snapshot survive a reload', () => {
	const env = load()
	const { game, stored } = env
	setBoard(env, withRow(0, [64, 64, 0, 0]))
	game.bonuses.undo = 1
	game.bonuses.swap = 1
	game.move(LEFT)
	assert.ok(stored.state, 'state was saved')

	const again = load(stored.state).game
	assert.deepStrictEqual(JSON.parse(JSON.stringify(again.bonuses)), { undo: 2, swap: 1, remove: 2 })
	assert.ok(again.reached[128])
	assert.ok(again.canUndo())
	assert.ok(again.undo())
	assert.deepStrictEqual(board(again)[0], [64, 64, 0, 0])
})

test('a state saved before the bonuses existed gets the defaults', () => {
	const env = load()
	const state = JSON.parse(JSON.stringify(env.game.serialize()))
	delete state.bonuses
	delete state.reached
	delete state.previous
	const again = load(state).game
	assert.deepStrictEqual(JSON.parse(JSON.stringify(again.bonuses)), { undo: 2, swap: 2, remove: 2 })
	assert.strictEqual(again.canUndo(), false)
})

test('a move that changes nothing keeps the undo snapshot of the move before', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(3, [2, 4, 8, 16])) // already at the bottom
	const snapshot = { marker: 'snapshot of an earlier move' }
	game.previous = snapshot
	game.move(2) // down: nothing moves
	assert.strictEqual(game.previous, snapshot)
	assert.strictEqual(game.moves, 0)
})

test('Keep going refreshes the bonus buttons', () => {
	const env = load()
	const { game, ctx } = env
	setBoard(env, withRow(0, [1024, 1024, 0, 0]))
	game.move(LEFT)
	assert.ok(game.won)
	const before = ctx.updates
	// the constructor-bound handler; the instance property of the same name holds the flag
	Object.getPrototypeOf(game).keepPlaying.call(game)
	assert.ok(ctx.updates > before)
	assert.strictEqual(game.canUseBonus('swap'), true)
})

test('undo renders the restored tiles in place instead of as new ones', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	game.move(2)
	game.undo()
	game.grid.eachCell((x, y, t) => { if (t) assert.ok(t.previousPosition, 'previousPosition set') })
})

test('the game over screen keeps the game for a reload while undo is possible', () => {
	const env = load()
	const { game, stored } = env
	setBoard(env, ONE_MOVE_FROM_STUCK)
	game.move(1)
	assert.ok(game.over)
	assert.ok(stored.state, 'game over state is kept')
	assert.strictEqual(stored.state.over, true)

	const again = load(stored.state).game
	assert.strictEqual(again.over, true)
	assert.ok(again.undo())
	assert.strictEqual(again.over, false)
	assert.strictEqual(stored.state.over, true, 'a separate env: first stored state untouched')
})

test('the saved game is cleared on game over once undo is not possible', () => {
	const env = load()
	const { game, stored } = env
	game.bonuses.undo = 0
	setBoard(env, ONE_MOVE_FROM_STUCK)
	game.move(1)
	assert.ok(game.over)
	assert.strictEqual(stored.state, null)
})

test('a shared game retains its terminal board for other browsers', () => {
	const env = load(null, { sharedGame: true })
	env.game.bonuses.undo = 0
	setBoard(env, ONE_MOVE_FROM_STUCK)
	env.game.move(1)
	assert.ok(env.game.over)
	assert.strictEqual(env.stored.state.over, true)
})

test('remote restoration replaces the board and preserves Undo and the random stream', () => {
	const source = load(null, { seed: 42 })
	for (const direction of [0, 1, 2, 3]) source.game.move(direction)
	const target = load(null, { seed: 42, sharedGame: true })
	target.stored.remoteChange(source.stored.state)
	assert.deepStrictEqual(board(target.game), board(source.game))
	assert.strictEqual(target.game.score, source.game.score)
	assert.strictEqual(target.game.random.state, source.game.random.state)
	assert.strictEqual(target.stored.selectionCancelled, true)
	assert.ok(target.game.undo())
	assert.ok(source.game.undo())
	assert.deepStrictEqual(board(target.game), board(source.game))
	for (const direction of [2, 1, 0]) {
		target.game.move(direction)
		source.game.move(direction)
	}
	assert.deepStrictEqual(board(target.game), board(source.game))
	assert.strictEqual(target.game.random.state, source.game.random.state)
})

test('New Game explicitly replaces a shared game instead of resuming it', () => {
	const env = load(null, { seed: 42, sharedGame: true })
	env.game.move(0)
	env.game.restart()
	assert.strictEqual(env.stored.restarts, 1)
	assert.strictEqual(env.game.moves, 0)
})

test('the best tile survives Remove taking it off the board', () => {
	const env = load()
	const { game } = env
	setBoard(env, withRow(0, [64, 64, 2, 0]))
	game.move(LEFT) // 128 on the board; actuate remembers it
	assert.strictEqual(game.stats().bestTile, 128)
	game.removeTilesOfValue(128)
	assert.strictEqual(game.stats().bestTile, 128)
})

test('Keep going is saved immediately and survives reload before the next move', () => {
	const env = load()
	setBoard(env, withRow(0, [1024, 1024, 0, 0]))
	env.game.move(LEFT)
	assert.strictEqual(env.game.inputManager.events.keepPlaying(), true)
	assert.strictEqual(env.stored.state.keepPlaying, true)
	const resumed = load(env.stored.state)
	assert.strictEqual(resumed.game.isGameTerminated(), false)
	assert.strictEqual(resumed.game.canUseBonus('swap'), true)
	assert.deepStrictEqual(env.stored.actions, [['move', LEFT], ['continue']])
	assert.strictEqual(env.game.inputManager.events.keepPlaying(), false)
	assert.strictEqual(env.stored.actions.length, 2)
})

test('the seeded generator has stable unsigned reference vectors', () => {
	const { ctx } = load()
	const rng = new ctx.SeededRandom(1)
	const actual = Array.from({ length: 6 }, () => rng.next() * 4294967296)
	assert.deepStrictEqual(actual, [270369, 67634689, 2647435461, 307599695, 2398689233, 745495504])
	assert.strictEqual(new ctx.SeededRandom(0xffffffff).next() * 4294967296, 253983)
	assert.throws(() => new ctx.SeededRandom(0), /Invalid game seed/)
})

test('the same seed and actions produce the same board and RNG state', () => {
	for (const seed of [1, 42, 0xffffffff]) {
		const first = load(null, { seed })
		const second = load(null, { seed })
		for (const direction of [0, 1, 2, 3, 0, 3, 2, 1, 3, 0]) {
			first.game.move(direction)
			second.game.move(direction)
		}
		assert.deepStrictEqual(board(first.game), board(second.game))
		assert.strictEqual(first.game.random.state, second.game.random.state)
		assert.deepStrictEqual(first.stored.actions, second.stored.actions)
	}
})

test('reload resumes the random stream rather than restarting it from the seed', () => {
	const first = load(null, { seed: 42 })
	for (const direction of [0, 1, 2, 3, 0]) first.game.move(direction)
	const resumed = load(first.stored.state, { seed: 42, actions: [...first.stored.actions] })
	for (const direction of [2, 1, 0, 3, 2, 0]) {
		first.game.move(direction)
		resumed.game.move(direction)
	}
	assert.deepStrictEqual(board(first.game), board(resumed.game))
	assert.strictEqual(first.game.random.state, resumed.game.random.state)
	assert.deepStrictEqual(first.stored.actions, resumed.stored.actions)
})

test('restart initializes a fresh deterministic game from the new server seed', async () => {
	const env = load(null, { seed: 1 })
	env.game.move(0)
	env.game.storageManager.prepareGame = function () {
		this.session = { seed: 42 }
		this.actions.length = 0
		return Promise.resolve(null)
	}
	env.game.restart()
	await new Promise(resolve => setImmediate(resolve))
	const fresh = load(null, { seed: 42 })
	assert.deepStrictEqual(board(env.game), board(fresh.game))
	assert.strictEqual(env.game.random.state, fresh.game.random.state)
	assert.strictEqual(env.game.moves, 0)
	assert.deepStrictEqual(env.stored.actions, [])
})

test('legacy v3 logs only successful move and bonus actions', () => {
	const env = load(null, { seed: 42, version: 3 })
	const game = env.game
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	game.move(LEFT) // already aligned: no-op
	assert.strictEqual(game.undo(), false)
	assert.strictEqual(game.swapTiles({ x: 0, y: 0 }, { x: 2, y: 0 }), false)
	assert.strictEqual(game.removeTilesOfValue(16), false)
	assert.strictEqual(game.inputManager.events.keepPlaying(), false)
	assert.deepStrictEqual(env.stored.actions, [])
	game.move(2)
	assert.ok(game.undo())
	assert.ok(game.swapTiles({ x: 0, y: 0 }, { x: 1, y: 0 }))
	assert.ok(game.removeTilesOfValue(2))
	assert.deepStrictEqual(env.stored.actions, [['move', 2], ['undo'], ['swap', 0, 0, 1, 0], ['remove', 2]])
	assert.strictEqual(game.undo(), false)
	assert.strictEqual(game.removeTilesOfValue(2), false)
	assert.strictEqual(env.stored.actions.length, 4)
})

test('Undo preserves the forward random stream and the historical peak tile', () => {
	const env = load(null, { seed: 1 })
	env.game.move(0)
	const rngAfterMove = env.game.random.state
	assert.ok(env.game.undo())
	assert.strictEqual(env.game.random.state, rngAfterMove)
	assert.strictEqual(env.game.score, 0)
	assert.strictEqual(env.game.maxTile, 4)
	env.game.move(0)
	assert.notStrictEqual(env.game.random.state, rngAfterMove)
	assert.deepStrictEqual(env.stored.actions, [['move', 0], ['undo'], ['move', 0]])
})

test('score metadata is refreshed on every successful action, even when score is unchanged', () => {
	const env = load()
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	const initial = env.stored.scores.length
	env.game.move(2)
	env.game.undo()
	env.game.swapTiles({ x: 0, y: 0 }, { x: 1, y: 0 })
	env.game.removeTilesOfValue(2)
	assert.strictEqual(env.stored.scores.length, initial + 4)
	assert.deepStrictEqual(env.stored.scores.map(s => s.moves).slice(initial), [1, 0, 0, 0])
})

test('input is ignored while verified initialization is pending', async () => {
	let resolveStart
	let preparations = 0
	const env = load(null, { seed: 42, prepareGame() {
		preparations++
		return new Promise(resolve => { resolveStart = resolve })
	} })
	assert.strictEqual(env.game.initializing, true)
	assert.strictEqual(env.game.grid, null)
	assert.strictEqual(env.game.isGameTerminated(), true)
	assert.strictEqual(env.game.canUseBonus('undo'), false)
	assert.strictEqual(env.game.canUseBonus('swap'), false)
	assert.strictEqual(env.game.canUseBonus('remove'), false)
	assert.doesNotThrow(() => env.game.move(0))
	assert.strictEqual(env.game.undo(), false)
	assert.strictEqual(env.game.swapTiles({ x: 0, y: 0 }, { x: 1, y: 0 }), false)
	assert.strictEqual(env.game.removeTilesOfValue(2), false)
	assert.strictEqual(env.game.inputManager.events.keepPlaying(), false)
	env.game.restart()
	assert.strictEqual(preparations, 1)
	assert.deepStrictEqual(env.stored.actions, [])
	resolveStart(null)
	await new Promise(resolve => setImmediate(resolve))
	assert.strictEqual(env.game.initializing, false)
	assert.ok(env.game.grid)
	assert.deepStrictEqual(board(env.game), board(load(null, { seed: 42 }).game))
})

test('failed initialization leaves input guarded and New Game retries successfully', async () => {
	let attempts = 0
	const env = load(null, { seed: 1, prepareGame() {
		attempts++
		return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(null)
	} })
	await new Promise(resolve => setImmediate(resolve))
	assert.strictEqual(env.game.initializing, false)
	assert.strictEqual(env.game.grid, null)
	assert.doesNotThrow(() => env.game.move(0))
	assert.strictEqual(env.game.undo(), false)
	assert.strictEqual(env.game.removeTilesOfValue(2), false)
	assert.deepStrictEqual(env.stored.actions, [])
	env.game.restart()
	await new Promise(resolve => setImmediate(resolve))
	assert.strictEqual(attempts, 2)
	assert.ok(env.game.grid)
	assert.strictEqual(env.game.initializing, false)
	assert.strictEqual(env.game.moves, 0)
})

test('asynchronous preparation restores the approved saved game and its RNG state', async () => {
	const before = load(null, { seed: 42 })
	for (const direction of [0, 1, 2, 3]) before.game.move(direction)
	const saved = before.stored.state
	let requested
	const env = load(saved, { seed: 42, actions: [...before.stored.actions], prepareGame(state) {
		requested = state
		return Promise.resolve(state)
	} })
	assert.strictEqual(env.game.grid, null)
	await new Promise(resolve => setImmediate(resolve))
	assert.strictEqual(requested, saved)
	assert.deepStrictEqual(board(env.game), board(before.game))
	assert.strictEqual(env.game.random.state, before.game.random.state)
	assert.strictEqual(env.game.moves, before.game.moves)
	assert.strictEqual(env.game.canUndo(), before.game.canUndo())
	env.game.move(0)
	before.game.move(0)
	assert.deepStrictEqual(board(env.game), board(before.game))
	assert.deepStrictEqual(env.stored.actions, before.stored.actions)
})

test('a late initialization result cannot replace a newer game', async () => {
	const pending = []
	const env = load(null, { seed: 1, prepareGame() {
		return new Promise(resolve => pending.push(resolve))
	} })
	const newer = load(null, { seed: 42 }).stored.state
	env.game.setup()
	pending[1](newer)
	await new Promise(resolve => setImmediate(resolve))
	const settled = board(env.game)
	pending[0](null)
	await new Promise(resolve => setImmediate(resolve))
	assert.deepStrictEqual(board(env.game), settled)
	assert.strictEqual(env.game.random.state, newer.randomState)
})

test('the 50000 action boundary prevents unrecorded changes and allows a restart', async () => {
	const env = load(null, { actions: Array.from({ length: 49999 }, () => ['move', 0]) })
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	env.game.move(2)
	assert.strictEqual(env.stored.actions.length, 50000)
	const before = JSON.parse(JSON.stringify(env.game.serialize()))
	env.game.move(0)
	assert.strictEqual(env.game.undo(), false)
	assert.strictEqual(env.game.swapTiles({ x: 0, y: 3 }, { x: 1, y: 3 }), false)
	assert.strictEqual(env.game.removeTilesOfValue(2), false)
	assert.deepStrictEqual(JSON.parse(JSON.stringify(env.game.serialize())), before)
	assert.strictEqual(env.stored.actions.length, 50000)
	env.game.storageManager.prepareGame = function () { this.actions.length = 0; return Promise.resolve(null) }
	assert.doesNotThrow(() => env.game.restart())
	await new Promise(resolve => setImmediate(resolve))
	assert.strictEqual(env.stored.actions.length, 0)
	assert.strictEqual(env.game.canRecordAction(), true)
	assert.strictEqual(env.game.moves, 0)
})

test('continuation cannot change or log a game beyond the action limit', () => {
	const env = load()
	setBoard(env, withRow(0, [1024, 1024, 0, 0]))
	env.game.move(LEFT)
	env.game.storageManager.actions.length = 50000
	assert.strictEqual(env.game.inputManager.events.keepPlaying(), false)
	assert.strictEqual(env.game.keepPlaying, false)
	assert.strictEqual(env.game.isGameTerminated(), true)
})

test('an active game transition blocks play while New Game can cancel it', () => {
	const env = load(null, { seed: 42, version: 2 })
	setBoard(env, withRow(0, [2, 4, 0, 0]))
	env.game.move(2)
	env.game.storageManager.gameTransitioning = true
	const before = copy(env.game.serialize())
	const actions = copy(env.stored.actions)
	assert.strictEqual(env.game.canRecordAction(), false)
	env.game.move(0)
	assert.strictEqual(env.game.undo(), false)
	assert.strictEqual(env.game.swapTiles({ x: 0, y: 3 }, { x: 1, y: 3 }), false)
	assert.strictEqual(env.game.removeTilesOfValue(2), false)
	assert.deepStrictEqual(copy(env.game.serialize()), before)
	assert.deepStrictEqual(env.stored.actions, actions)
	env.game.storageManager.gameTransitioning = false
	assert.strictEqual(env.game.canRecordAction(), true)
	assert.strictEqual(env.game.undo(), true)
	assert.strictEqual(env.stored.actions.length, actions.length + 1)

	const won = load(null, { seed: 42, version: 2 })
	setBoard(won, withRow(0, [1024, 1024, 0, 0]))
	won.game.move(LEFT)
	won.game.storageManager.gameTransitioning = true
	assert.strictEqual(won.game.inputManager.events.keepPlaying(), false)
	assert.strictEqual(won.game.keepPlaying, false)
	assert.deepStrictEqual(won.stored.actions, [['move', LEFT]])
	won.game.storageManager.gameTransitioning = false
	assert.strictEqual(won.game.inputManager.events.keepPlaying(), true)

	const restarted = load(null, { seed: 42, version: 2, sharedGame: true })
	restarted.game.move(0)
	assert.ok(restarted.game.moves > 0)
	restarted.game.storageManager.gameTransitioning = true
	restarted.game.restart()
	assert.strictEqual(restarted.stored.restarts, 1, 'New Game explicitly cancels the pending transition')
	assert.strictEqual(restarted.game.moves, 0)
	assert.strictEqual(restarted.game.canRecordAction(), true)
	assert.deepStrictEqual(copy(restarted.game.pendingBonuses), { undo: 0, swap: 0, remove: 0 })
})

test('v2 banked awards survive genuine seeded histories, reload, successful use and deterministic replay', () => {
	const { createGame, apply, chooseMove } = require('./generate_replay_fixtures')
	for (const [value, type] of MILESTONES) {
		let env = createGame(42, null, null, 2)
		for (let i = 0; i < 2500 && !env.game.reached[value] && !env.game.isGameTerminated(); i++) {
			const direction = chooseMove(env.game)
			assert.notStrictEqual(direction, null, 'the seeded history must reach ' + value)
			const count = env.stored.actions.length
			apply(env, ['move', direction])
			assert.strictEqual(env.stored.actions.length, count + 1)
		}
		assert.strictEqual(env.game.reached[value], true, 'genuine first ' + value)
		assert.strictEqual(env.game.bonuses[type], 2)
		assert.strictEqual(env.game.pendingBonuses[type], 1)
		const saved = copy(env.stored.state)
		env = createGame(42, saved, copy(env.stored), 2)
		assert.strictEqual(env.game.pendingBonuses[type], 1)
		assert.strictEqual(spendBonus(env.game, type), true)
		assert.strictEqual(env.game.bonuses[type], 2)
		assert.strictEqual(env.game.pendingBonuses[type], 0)
		assert.strictEqual(env.game.reached[value], true)
		const replayed = createGame(42, null, null, 2)
		for (const action of env.stored.actions) {
			const count = replayed.stored.actions.length
			apply(replayed, action)
			assert.strictEqual(replayed.stored.actions.length, count + 1)
		}
		assert.deepStrictEqual(copy(replayed.game.serialize()), copy(env.game.serialize()), type + ': actual replay restores all state')
		assert.deepStrictEqual(replayed.stored.actions, env.stored.actions)
	}
})

test('v3 genuine seeded histories replenish spent charges on later threshold merges and replay after reload', () => {
	const { createGame, apply, chooseMove } = require('./generate_replay_fixtures')
	for (const [value, type] of MILESTONES) {
		let env = createGame(42, null, null, 3)
		for (let i = 0; i < 2500 && !env.game.reached[value] && !env.game.isGameTerminated(); i++) {
			const direction = chooseMove(env.game)
			assert.notStrictEqual(direction, null, 'the seeded history must reach ' + value)
			const count = env.stored.actions.length
			apply(env, ['move', direction])
			assert.strictEqual(env.stored.actions.length, count + 1)
		}
		assert.strictEqual(env.game.reached[value], true)
		assert.strictEqual(env.game.bonuses[type], 2)
		const saved = copy(env.stored.state)
		env = createGame(42, saved, copy(env.stored), 3)
		assert.strictEqual(spendBonus(env.game, type), true)
		assert.strictEqual(env.game.bonuses[type], 1, type + ': spending after the first full-cap merge costs a charge')
		for (let i = 0; i < 2500 && env.game.bonuses[type] < 2 && !env.game.isGameTerminated(); i++) {
			const direction = chooseMove(env.game)
			assert.notStrictEqual(direction, null, 'the history must reach another ' + value)
			apply(env, ['move', direction])
		}
		assert.strictEqual(env.game.bonuses[type], 2, type + ': a genuine later matching merge replenishes the charge')
		assert.strictEqual(Object.hasOwn(env.game.serialize(), 'pendingBonuses'), false)
		const replayed = createGame(42, null, null, 3)
		for (const action of env.stored.actions) {
			const count = replayed.stored.actions.length
			apply(replayed, action)
			assert.strictEqual(replayed.stored.actions.length, count + 1)
		}
		assert.deepStrictEqual(copy(replayed.game.serialize()), copy(env.game.serialize()), type + ': complete v3 replay state')
		assert.deepStrictEqual(replayed.stored.actions, env.stored.actions)
	}
})

test('golden replay fixtures match the real browser rules, including a genuine 2048 win', () => {
	const { createGame, apply, expected } = require('./generate_replay_fixtures')
	const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'replay.json'), 'utf8'))
	assert.ok(fixtures.some(f => f.expected.state.won && f.expected.state.keepPlaying), 'verified continuation included')
	assert.ok(fixtures.some(f => f.expected.state.over), 'game-over included')
	for (const fixture of fixtures) {
		const env = createGame(fixture.seed, null, null, fixture.version || 1)
		for (const action of fixture.actions) {
			const length = env.stored.actions.length
			apply(env, action)
			assert.strictEqual(env.stored.actions.length, length + 1, fixture.name + ': recorded action must succeed')
		}
		assert.deepStrictEqual(expected(env), fixture.expected, fixture.name)
		const serialized = game => JSON.parse(JSON.stringify({ ...game.serialize(), peakScore: fixture.savedState.peakScore }))
		assert.deepStrictEqual(serialized(env.game), fixture.savedState, fixture.name + ': complete server restoration state')
		const resumed = createGame(fixture.seed, fixture.savedState, {
			actions: JSON.parse(JSON.stringify(fixture.actions)),
			peakScore: fixture.savedState.peakScore,
			movesAtPeakScore: fixture.expected.movesAtPeakScore,
			bestTileEver: fixture.expected.bestTileEver
		}, fixture.version || 1)
		assert.deepStrictEqual(serialized(resumed.game), fixture.savedState, fixture.name + ': restoration round trip')
	}
})

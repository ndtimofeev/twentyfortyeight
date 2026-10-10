// Rules of the bonus actions. The browser-side classes are loaded into a vm
// context with stubs for everything that touches the DOM.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function load(savedState) {
	const math = Object.create(Math)
	math.random = () => 0.5

	const stored = { state: savedState || null }
	const ctx = vm.createContext({ console, Math: math, JSON })
	ctx.BonusUI = class { tap() {} update() {} }
	ctx.InputManager = class { on() {} }
	ctx.Actuator = class { actuate() {} continueGame() { ctx.continued = (ctx.continued || 0) + 1 } }
	ctx.Storage = class {
		getBestScore() { return 0 }
		setBestScore() {}
		getGameState() { return stored.state }
		setGameState(s) { stored.state = JSON.parse(JSON.stringify(s)) }
		clearGameState() { stored.state = null }
	}
	for (const file of ['grid', 'tile', 'game_manager']) {
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

test('the charge comes only once per game for each tile', () => {
	const env = load()
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

test('undo and redo of a merge does not farm charges', () => {
	const env = load()
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

test('swap and remove make undo unavailable until the next move', () => {
	const env = load()
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

test('a swap that leaves no moves ends the game', () => {
	const env = load()
	const { game } = env
	// the only equal neighbours are the two 2s at the top left; swapping one away locks the board
	setBoard(env, [[2, 2, 4, 8], [16, 32, 64, 128], [256, 512, 1024, 2048], [4096, 8192, 16384, 32768]])
	assert.ok(game.movesAvailable())
	assert.ok(game.swapTiles({ x: 0, y: 0 }, { x: 3, y: 2 }))
	assert.ok(game.over)
})

test('remove deletes every tile with that value only', () => {
	const env = load()
	const { game } = env
	setBoard(env, [[2, 4, 2, 0], [0, 2, 8, 4], [0, 0, 0, 0], [2, 0, 0, 0]])
	assert.ok(game.removeTilesOfValue(2))
	assert.deepStrictEqual(board(game), [[0, 4, 0, 0], [0, 0, 8, 4], [0, 0, 0, 0], [0, 0, 0, 0]])
	assert.strictEqual(game.bonuses.remove, 1)
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

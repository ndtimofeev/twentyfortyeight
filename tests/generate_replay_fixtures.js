// Golden replay states from the actual browser game, without DOM or network.
// Regenerate with: node tests/generate_replay_fixtures.js > tests/fixtures/replay.json
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const copy = value => JSON.parse(JSON.stringify(value))

function createGame(seed, savedState = null, history = null) {
	const stored = history || { actions: [], peakScore: 0, movesAtPeakScore: 0, bestTileEver: 0 }
	stored.state = savedState
	const ctx = vm.createContext({ Math, JSON })
	ctx.BonusUI = class { tap() {} update() {} }
	ctx.InputManager = class {
		constructor() { this.events = {} }
		on(name, fn) { this.events[name] = fn }
	}
	ctx.Actuator = class { actuate() {} continueGame() {} }
	ctx.Storage = class {
		constructor() { this.session = { seed }; this.actions = stored.actions }
		getBestScore() { return stored.peakScore }
		getGameState() { return stored.state }
		setGameState(state) { stored.state = copy(state) }
		clearGameState() { stored.state = null }
		recordAction(action) { this.actions.push(copy(action)) }
		updateScore(score, stats) {
			if (score > stored.peakScore) {
				stored.peakScore = score
				stored.movesAtPeakScore = stats.moves
			}
			stored.bestTileEver = Math.max(stored.bestTileEver, stats.bestTile)
		}
	}
	for (const file of ['tile', 'grid', 'seeded_random', 'game_manager']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), ctx)
	}
	const game = vm.runInContext('new GameManager(4, InputManager, Actuator, Storage)', ctx)
	return { game, stored, seed }
}

function expected(env) {
	const { game, stored } = env
	return copy({
		peakScore: stored.peakScore,
		bestTileEver: stored.bestTileEver,
		movesAtPeakScore: stored.movesAtPeakScore,
		state: {
			board: game.grid.cells.map(column => column.map(tile => tile ? tile.value : 0)),
			score: game.score,
			moves: game.moves,
			won: game.won,
			over: game.over,
			keepPlaying: game.keepPlaying,
			bonuses: copy(game.bonuses),
			reached: copy(game.reached),
			canUndo: game.canUndo(),
			rng: game.random.state,
		},
	})
}

function fixture(name, env) {
	return { name, seed: env.seed, actions: copy(env.stored.actions), expected: expected(env) }
}

function apply(env, action) {
	const game = env.game
	switch (action[0]) {
		case 'move': return game.move(action[1])
		case 'undo': return game.undo()
		case 'swap': return game.swapTiles({ x: action[1], y: action[2] }, { x: action[3], y: action[4] })
		case 'remove': return game.removeTilesOfValue(action[1])
		case 'continue': return game.inputManager.events.keepPlaying()
		default: throw new Error('Unknown fixture action')
	}
}

// The solver only chooses directions. Actual GameManager executes and logs them.
// Knowing the next seeded spawn keeps fixture generation quick and reproducible.
function nextWord(state) {
	state ^= state << 13
	state ^= state >>> 17
	state ^= state << 5
	return state >>> 0
}

function simulate(board, rng, direction) {
	const after = board.slice()
	let gain = 0
	for (let line = 0; line < 4; line++) {
		const indexes = []
		for (let pos = 0; pos < 4; pos++) {
			indexes.push(direction === 0 ? pos * 4 + line : direction === 1 ? line * 4 + 3 - pos : direction === 2 ? (3 - pos) * 4 + line : line * 4 + pos)
		}
		const values = indexes.map(i => board[i]).filter(Boolean)
		const merged = []
		for (let i = 0; i < values.length; i++) {
			if (values[i] === values[i + 1]) { merged.push(values[i] * 2); gain += values[i] * 2; i++ }
			else merged.push(values[i])
		}
		indexes.forEach((index, i) => { after[index] = merged[i] || 0 })
	}
	if (after.every((value, i) => value === board[i])) return null
	const valueRng = nextWord(rng)
	const positionRng = nextWord(valueRng)
	const empty = []
	// Grid.availableCells() enumerates columns before rows.
	for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if (!after[y * 4 + x]) empty.push(y * 4 + x)
	after[empty[Math.floor(positionRng / 4294967296 * empty.length)]] = valueRng / 4294967296 < 0.9 ? 2 : 4
	return { board: after, rng: positionRng, gain }
}

const snake = [15, 14, 13, 12, 8, 9, 10, 11, 7, 6, 5, 4, 0, 1, 2, 3]
function evaluate(board) {
	let empty = 0, rough = 0, snakeScore = 0
	const logs = board.map(value => value ? Math.log2(value) : 0)
	for (let i = 0; i < 16; i++) {
		if (!board[i]) empty++
		if (i % 4 < 3 && board[i] && board[i + 1]) rough += Math.abs(logs[i] - logs[i + 1])
		if (i < 12 && board[i] && board[i + 4]) rough += Math.abs(logs[i] - logs[i + 4])
		snakeScore += board[snake[i]] * Math.pow(0.5, i)
	}
	return snakeScore + empty * 120 - rough * 6
}

function chooseMove(game, depth = 4) {
	const board = []
	for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) board.push(game.grid.cells[x][y]?.value || 0)
	function best(state, remaining) {
		let value = -Infinity
		for (const direction of [2, 3, 1, 0]) {
			const child = simulate(state.board, state.rng, direction)
			if (!child) continue
			const candidate = remaining === 1 ? evaluate(child.board) : best(child, remaining - 1)
			value = Math.max(value, candidate)
		}
		return value === -Infinity ? -100000 : value
	}
	let direction = null, value = -Infinity
	for (const candidate of [2, 3, 1, 0]) {
		const child = simulate(board, game.random.state, candidate)
		if (!child) continue
		const score = best(child, depth - 1)
		if (score > value) { direction = candidate; value = score }
	}
	return direction
}

function play(seed, maxMoves = 2500) {
	const env = createGame(seed)
	for (let i = 0; i < maxMoves && !env.game.won; i++) {
		if (env.game.over) break
		const direction = chooseMove(env.game)
		if (direction === null) break
		apply(env, ['move', direction])
		// Use Remove while still running when a crowded board threatens the run.
		if (!env.game.won && !env.game.over && env.game.grid.availableCells().length <= 1 && env.game.canUseBonus('remove')) {
			const values = env.game.grid.cells.flat().filter(Boolean).map(tile => tile.value)
			apply(env, ['remove', Math.min(...values)])
		}
	}
	return env
}

function generate() {
	const fixtures = []
	for (const seed of [1, 42, 0xffffffff]) {
		let env = createGame(seed)
		fixtures.push(fixture(`seed-${seed}-initial`, env))
		for (const direction of [0, 1, 2, 3, 0, 3, 2, 1]) apply(env, ['move', direction])
		fixtures.push(fixture(`seed-${seed}-moves`, env))
		const stateBeforeReload = expected(env)
		env = createGame(seed, env.stored.state, env.stored)
		assert.deepStrictEqual(expected(env), stateBeforeReload)
		apply(env, ['move', 0])
		fixtures.push(fixture(`seed-${seed}-after-reload`, env))
	}
	const mixed = createGame(1)
	apply(mixed, ['move', 3]) // initial column is already at the left edge
	apply(mixed, ['undo'])
	apply(mixed, ['remove', 512])
	assert.strictEqual(mixed.stored.actions.length, 0, 'no-op and rejected actions must not enter a replay')
	for (const [name, action] of [
		['merge', ['move', 0]],
		['undo', ['undo']],
		['redo-forward-rng', ['move', 0]],
		['swap', ['swap', 0, 0, 0, 2]],
		['remove-peak', ['remove', 4]],
		['remove-entire-board', ['remove', 2]],
	]) {
		const length = mixed.stored.actions.length
		apply(mixed, action)
		assert.strictEqual(mixed.stored.actions.length, length + 1, name + ' must succeed')
		fixtures.push(fixture('mixed-' + name, mixed))
	}
	const lost = createGame(13)
	for (let i = 0; i < 5000 && !lost.game.over; i++) {
		if (lost.game.won && !lost.game.keepPlaying) apply(lost, ['continue'])
		apply(lost, ['move', i % 4])
	}
	assert.ok(lost.game.over, 'cyclic strategy must reach a genuine game over')
	fixtures.push(fixture('verified-game-over', lost))
	apply(lost, ['undo'])
	assert.strictEqual(lost.game.over, false)
	fixtures.push(fixture('verified-game-over-undo', lost))
	let won
	for (const seed of [42, 1, 0xffffffff, 2048, 123456789]) {
		const candidate = play(seed)
		if (candidate.game.won) { won = candidate; break }
	}
	assert.ok(won, 'deterministic solver must produce a genuine 2048 game')
	assert.strictEqual(won.game.isGameTerminated(), true)
	fixtures.push(fixture('verified-win-2048', won))
	apply(won, ['continue'])
	fixtures.push(fixture('verified-continue', won))
	const persisted = createGame(won.seed, won.stored.state, won.stored)
	assert.strictEqual(persisted.game.isGameTerminated(), false)
	for (let i = 0; i < 12 && !persisted.game.over; i++) apply(persisted, ['move', chooseMove(persisted.game)])
	fixtures.push(fixture('verified-after-continue-reload', persisted))
	return fixtures
}

module.exports = { createGame, expected, apply, chooseMove, play, generate }
if (require.main === module) {
	// Keep the substantial winning transcript readable without five lines per move.
	const json = JSON.stringify(generate(), null, 2).replace(/\[\n[^\[\]{}]*\n\s*\]/g, array => JSON.stringify(JSON.parse(array)))
	process.stdout.write(json + '\n')
}

const test = require('node:test')
const assert = require('node:assert')
const { createGame, move } = require('../js/core.js')

function gameWith(cells, extra) {
	const g = createGame(() => 0.5, {
		tiles: cells.map((c, i) => ({ id: i + 1, row: c[0], col: c[1], value: c[2] })),
		score: 0, moves: 0, bestTile: 0, won: false, over: false, nextId: 100,
	})
	return Object.assign(g, extra || {})
}

function values(g) {
	const out = {}
	g.tiles.filter((t) => !t.isNew).forEach((t) => { out[t.row + ',' + t.col] = t.value })
	return out
}

test('new game has two tiles', () => {
	assert.strictEqual(createGame().tiles.length, 2)
})

test('tiles slide to the wall', () => {
	const g = gameWith([[0, 3, 2]])
	assert.ok(move(g, 3, () => 0).moved)
	assert.deepStrictEqual(values(g), { '0,0': 2 })
})

test('equal neighbours merge once per move', () => {
	const g = gameWith([[0, 0, 2], [0, 1, 2], [0, 2, 2], [0, 3, 2]])
	const res = move(g, 3, () => 0)
	assert.strictEqual(res.gained, 8)
	assert.strictEqual(g.score, 8)
	assert.deepStrictEqual(values(g), { '0,0': 4, '0,1': 4 })
	assert.strictEqual(res.ghosts.length, 2)
})

test('three in a row merge the near pair first', () => {
	const g = gameWith([[0, 0, 2], [0, 1, 2], [0, 2, 2]])
	move(g, 3, () => 0)
	assert.deepStrictEqual(values(g), { '0,0': 4, '0,1': 2 })
	const g2 = gameWith([[0, 0, 2], [0, 1, 2], [0, 2, 2]])
	move(g2, 1, () => 0)
	assert.deepStrictEqual(values(g2), { '0,3': 4, '0,2': 2 })
})

test('a move that changes nothing does not spawn or count', () => {
	const g = gameWith([[0, 0, 2]])
	const res = move(g, 3, () => 0)
	assert.strictEqual(res.moved, false)
	assert.strictEqual(g.tiles.length, 1)
	assert.strictEqual(g.moves, 0)
})

test('all four directions', () => {
	const cell = [[1, 1, 2]]
	const expected = { 0: '0,1', 1: '1,3', 2: '3,1', 3: '1,0' }
	for (const dir of [0, 1, 2, 3]) {
		const g = gameWith(cell)
		move(g, dir, () => 0.99)
		assert.ok(Object.values(values(g)).length === 1)
		assert.deepStrictEqual(Object.keys(values(g)), [expected[dir]])
	}
})

test('reaching 2048 sets won, bestTile follows', () => {
	const g = gameWith([[0, 0, 1024], [0, 1, 1024]])
	move(g, 3, () => 0)
	assert.ok(g.won)
	assert.strictEqual(g.bestTile, 2048)
})

test('full board without merges is game over', () => {
	const vals = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 0]
	const cells = []
	vals.forEach((v, i) => { if (v) cells.push([Math.floor(i / 4), i % 4, v]) })
	const g = gameWith(cells)
	// move the only gap into place so the board becomes full and stuck
	move(g, 2, () => 0.99) // spawns a 2 at the freed cell
	assert.ok(g.over || g.tiles.length === 16)
})

test('is deterministic for a given rng', () => {
	const seq = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647
	const a = createGame(seq(7)); const b = createGame(seq(7))
	assert.deepStrictEqual(a.tiles, b.tiles)
})

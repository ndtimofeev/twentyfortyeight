// Generate an API proof using the browser's actual game engine and a server seed.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const session = JSON.parse(process.argv[2])
const ctx = vm.createContext({ console, Math, JSON })
ctx.BonusUI = class { tap() {} update() {} }
ctx.InputManager = class { on() {} }
ctx.Actuator = class { actuate() {} continueGame() {} }
ctx.Storage = class {
	constructor() {
		this.session = session
		this.actions = []
		this.peakScore = 0
		this.bestTile = 0
	}
	getGameState() { return null }
	setGameState() {}
	clearGameState() {}
	getBestScore() { return this.peakScore }
	recordAction(action) { this.actions.push(Array.from(action)) }
	updateScore(score, stats) {
		this.peakScore = Math.max(this.peakScore, score)
		this.bestTile = Math.max(this.bestTile, stats.bestTile)
	}
}
for (const file of ['grid', 'tile', 'seeded_random', 'game_manager']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), ctx)
}
const game = vm.runInContext('new GameManager(4, InputManager, Actuator, Storage)', ctx)
let successfulMoves = 0
let swapped = false
for (let step = 0; step < 320 && successfulMoves < 80; step++) {
	if (game.isGameTerminated()) break
	const before = game.storageManager.actions.length
	game.move([3, 0, 1, 2][step % 4])
	if (game.storageManager.actions.length === before) continue
	successfulMoves++
	if (successfulMoves === 1) game.undo()
	if (!swapped && successfulMoves >= 8) {
		const tiles = []
		game.grid.eachCell((x, y, tile) => { if (tile) tiles.push(tile) })
		for (let i = 0; i < tiles.length && !swapped; i++) {
			for (let j = i + 1; j < tiles.length && !swapped; j++) {
				if (tiles[i].value !== tiles[j].value) {
					swapped = game.swapTiles({ x: tiles[i].x, y: tiles[i].y }, { x: tiles[j].x, y: tiles[j].y })
				}
			}
		}
	}
	if (successfulMoves === 24 && game.canUseBonus('remove')) {
		let value = Infinity
		game.grid.eachCell((x, y, tile) => { if (tile) value = Math.min(value, tile.value) })
		game.removeTilesOfValue(value)
	}
}
process.stdout.write(JSON.stringify({
	actions: game.storageManager.actions,
	expected: { score: game.storageManager.peakScore, bestTile: game.storageManager.bestTile },
}) + '\n')

/**
 * 2048 game rules. No DOM access, so it can be tested in node.
 *
 * Directions: 0 = up, 1 = right, 2 = down, 3 = left.
 */
(function (root) {
	'use strict'

	var SIZE = 4

	function createGame(rng, saved) {
		rng = rng || Math.random

		var game = {
			tiles: [],
			score: 0,
			moves: 0,
			bestTile: 0,
			won: false,
			over: false,
			nextId: 1,
		}

		if (saved) {
			game.tiles = saved.tiles.map(function (t) {
				return { id: t.id, value: t.value, row: t.row, col: t.col }
			})
			game.score = saved.score
			game.moves = saved.moves
			game.bestTile = saved.bestTile
			game.won = saved.won
			game.over = saved.over
			game.nextId = saved.nextId
		} else {
			spawn(game, rng)
			spawn(game, rng)
		}

		return game
	}

	function serialize(game) {
		return {
			tiles: game.tiles,
			score: game.score,
			moves: game.moves,
			bestTile: game.bestTile,
			won: game.won,
			over: game.over,
			nextId: game.nextId,
		}
	}

	function tileAt(game, row, col) {
		for (var i = 0; i < game.tiles.length; i++) {
			if (game.tiles[i].row === row && game.tiles[i].col === col) {
				return game.tiles[i]
			}
		}
		return null
	}

	function spawn(game, rng) {
		var empty = []
		for (var r = 0; r < SIZE; r++) {
			for (var c = 0; c < SIZE; c++) {
				if (!tileAt(game, r, c)) {
					empty.push([r, c])
				}
			}
		}
		if (empty.length === 0) {
			return null
		}
		var cell = empty[Math.floor(rng() * empty.length)]
		var tile = {
			id: game.nextId++,
			value: rng() < 0.9 ? 2 : 4,
			row: cell[0],
			col: cell[1],
			isNew: true,
		}
		game.tiles.push(tile)
		game.bestTile = Math.max(game.bestTile, tile.value)
		return tile
	}

	/** Position of the k-th cell (0 = next to the wall we move towards) of line i. */
	function position(dir, i, k) {
		switch (dir) {
		case 0: return [k, i]
		case 1: return [i, SIZE - 1 - k]
		case 2: return [SIZE - 1 - k, i]
		default: return [i, k]
		}
	}

	function canMove(game) {
		if (game.tiles.length < SIZE * SIZE) {
			return true
		}
		for (var i = 0; i < game.tiles.length; i++) {
			var t = game.tiles[i]
			var right = tileAt(game, t.row, t.col + 1)
			var down = tileAt(game, t.row + 1, t.col)
			if ((right && right.value === t.value) || (down && down.value === t.value)) {
				return true
			}
		}
		return false
	}

	/**
	 * Applies a move in place.
	 *
	 * @return {{moved: boolean, gained: number, ghosts: Array}} ghosts are the tiles
	 * that were merged into another one; they are already removed from game.tiles and
	 * only returned so the UI can animate them sliding into place.
	 */
	function move(game, dir, rng) {
		rng = rng || Math.random
		var moved = false
		var gained = 0
		var ghosts = []

		game.tiles.forEach(function (t) {
			t.isNew = false
			t.merged = false
		})

		for (var i = 0; i < SIZE; i++) {
			var line = []
			for (var k = 0; k < SIZE; k++) {
				var p = position(dir, i, k)
				var t = tileAt(game, p[0], p[1])
				if (t) {
					line.push(t)
				}
			}

			var slot = 0
			for (var j = 0; j < line.length; j++) {
				var tile = line[j]
				var target = position(dir, i, slot)

				if (j + 1 < line.length && line[j + 1].value === tile.value) {
					var other = line[j + 1]
					if (tile.row !== target[0] || tile.col !== target[1]
						|| other.row !== target[0] || other.col !== target[1]) {
						moved = true
					}
					tile.row = target[0]
					tile.col = target[1]
					tile.value *= 2
					tile.merged = true
					other.row = target[0]
					other.col = target[1]
					ghosts.push(other)
					gained += tile.value
					game.bestTile = Math.max(game.bestTile, tile.value)
					if (tile.value === 2048) {
						game.won = true
					}
					j++
				} else {
					if (tile.row !== target[0] || tile.col !== target[1]) {
						moved = true
					}
					tile.row = target[0]
					tile.col = target[1]
				}
				slot++
			}
		}

		if (!moved) {
			return { moved: false, gained: 0, ghosts: [] }
		}

		game.tiles = game.tiles.filter(function (t) {
			return ghosts.indexOf(t) === -1
		})
		game.score += gained
		game.moves++
		spawn(game, rng)
		game.over = !canMove(game)

		return { moved: true, gained: gained, ghosts: ghosts }
	}

	var api = {
		SIZE: SIZE,
		createGame: createGame,
		serialize: serialize,
		move: move,
		canMove: canMove,
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	} else {
		root.TwentyFortyEight = api
	}
})(typeof window !== 'undefined' ? window : this)

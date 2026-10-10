(function () {
	'use strict'

	var Core = window.TwentyFortyEight
	var STORAGE_KEY = 'twentyfortyeight.game'
	var SUBMIT_DELAY = 1500

	var root = document.querySelector('.tfe')
	if (!root) {
		return
	}
	var scoresUrl = root.dataset.scoresUrl

	var els = {
		score: document.getElementById('tfe-score'),
		best: document.getElementById('tfe-best'),
		board: document.getElementById('tfe-board'),
		tiles: document.getElementById('tfe-tiles'),
		message: document.getElementById('tfe-message'),
		messageText: document.getElementById('tfe-message-text'),
		keepGoing: document.getElementById('tfe-continue'),
		list: document.getElementById('tfe-list'),
		empty: document.getElementById('tfe-empty'),
		me: document.getElementById('tfe-me'),
	}

	var game = null
	var nodes = {} // tile id -> element
	var serverBest = 0
	var submittedScore = 0
	var submitTimer = null
	var keepPlaying = false

	// --- persistence of the running game (per browser, only a convenience) ---

	function saveLocal() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(Core.serialize(game)))
		} catch (e) { /* storage unavailable */ }
	}

	function loadLocal() {
		try {
			var raw = localStorage.getItem(STORAGE_KEY)
			if (raw) {
				var saved = JSON.parse(raw)
				if (saved && Array.isArray(saved.tiles) && !saved.over) {
					return saved
				}
			}
		} catch (e) { /* ignore broken data */ }
		return null
	}

	// --- server communication ---

	function request(method, body) {
		var token = document.head.getAttribute('data-requesttoken')
		var headers = { requesttoken: token, Accept: 'application/json' }
		var opts = { method: method, headers: headers, credentials: 'same-origin' }
		if (body) {
			headers['Content-Type'] = 'application/json'
			opts.body = JSON.stringify(body)
		}
		return fetch(scoresUrl, opts).then(function (res) {
			if (!res.ok) {
				throw new Error('HTTP ' + res.status)
			}
			return res.json()
		})
	}

	function applyServerData(data) {
		renderLeaderboard(data)
		serverBest = data.me ? data.me.score : 0
		submittedScore = Math.max(submittedScore, serverBest)
		els.best.textContent = Math.max(serverBest, game ? game.score : 0)
	}

	function refreshLeaderboard() {
		return request('GET').then(applyServerData).catch(function () {})
	}

	function submit() {
		clearTimeout(submitTimer)
		submitTimer = null
		if (!game || game.score <= submittedScore) {
			return
		}
		var score = game.score
		request('POST', { score: score, bestTile: game.bestTile, moves: game.moves })
			.then(function (data) {
				submittedScore = Math.max(submittedScore, score)
				applyServerData(data)
			})
			.catch(function () {})
	}

	function scheduleSubmit(immediately) {
		if (game.score <= submittedScore) {
			return
		}
		if (immediately) {
			submit()
		} else if (!submitTimer) {
			submitTimer = setTimeout(submit, SUBMIT_DELAY)
		}
	}

	// --- rendering ---

	function renderLeaderboard(data) {
		els.list.textContent = ''
		els.empty.hidden = data.leaderboard.length > 0
		data.leaderboard.forEach(function (row) {
			var li = document.createElement('li')
			if (row.isMe) {
				li.className = 'tfe-mine'
			}
			var name = document.createElement('span')
			name.className = 'tfe-name'
			name.textContent = row.displayName
			var tile = document.createElement('span')
			tile.className = 'tfe-best-tile'
			tile.textContent = row.bestTile || ''
			var score = document.createElement('strong')
			score.textContent = row.score
			li.appendChild(name)
			li.appendChild(tile)
			li.appendChild(score)
			els.list.appendChild(li)
		})
		els.me.textContent = data.me
			? 'Your place: #' + data.me.rank + ' (' + data.me.score + ')'
			: 'You have no score yet.'
	}

	function place(el, tile) {
		el.style.setProperty('--r', tile.row)
		el.style.setProperty('--c', tile.col)
	}

	function setValue(el, value) {
		el.textContent = value
		el.className = 'tfe-tile tfe-tile-' + (value > 2048 ? 'super' : value)
	}

	function pop(el, kind) {
		el.classList.remove('tfe-new', 'tfe-merged')
		void el.offsetWidth // restart the animation
		el.classList.add(kind)
	}

	function render(ghosts) {
		var alive = {}
		game.tiles.forEach(function (tile) {
			alive[tile.id] = true
			var el = nodes[tile.id]
			if (!el) {
				el = document.createElement('div')
				nodes[tile.id] = el
				els.tiles.appendChild(el)
				place(el, tile)
				setValue(el, tile.value)
				if (tile.isNew) {
					pop(el, 'tfe-new')
				}
			} else {
				place(el, tile)
				if (tile.merged) {
					setValue(el, tile.value)
					pop(el, 'tfe-merged')
				}
			}
		})

		// Merged-away tiles slide into their destination, then disappear.
		;(ghosts || []).forEach(function (tile) {
			var el = nodes[tile.id]
			if (el) {
				place(el, tile)
				el.style.zIndex = 0
				delete nodes[tile.id]
				setTimeout(function () { el.remove() }, 120)
			}
		})

		Object.keys(nodes).forEach(function (id) {
			if (!alive[id]) {
				nodes[id].remove()
				delete nodes[id]
			}
		})

		els.score.textContent = game.score
		els.best.textContent = Math.max(serverBest, game.score)
		updateMessage()
	}

	function updateMessage() {
		var text = ''
		els.keepGoing.hidden = true
		if (game.over) {
			text = 'Game over!'
		} else if (game.won && !keepPlaying) {
			text = 'You win!'
			els.keepGoing.hidden = false
		}
		els.messageText.textContent = text
		els.message.hidden = text === ''
	}

	// --- game flow ---

	function newGame() {
		scheduleSubmit(true)
		game = Core.createGame()
		keepPlaying = false
		els.tiles.textContent = ''
		nodes = {}
		render()
		saveLocal()
	}

	function doMove(dir) {
		if (game.over || (game.won && !keepPlaying)) {
			return
		}
		var result = Core.move(game, dir)
		if (!result.moved) {
			return
		}
		render(result.ghosts)
		saveLocal()
		scheduleSubmit(game.over)
	}

	// --- input ---

	var KEYS = {
		ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
		w: 0, d: 1, s: 2, a: 3,
	}

	document.addEventListener('keydown', function (e) {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
			return
		}
		var target = e.target
		if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || (target && target.isContentEditable)) {
			return
		}
		var dir = KEYS[e.key]
		if (dir === undefined) {
			return
		}
		e.preventDefault()
		doMove(dir)
	})

	var touchStart = null
	els.board.addEventListener('touchstart', function (e) {
		if (e.touches.length === 1) {
			touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }
		} else {
			touchStart = null
		}
	}, { passive: true })
	els.board.addEventListener('touchend', function (e) {
		if (!touchStart) {
			return
		}
		var t = e.changedTouches[0]
		var dx = t.clientX - touchStart.x
		var dy = t.clientY - touchStart.y
		touchStart = null
		if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) {
			return
		}
		if (Math.abs(dx) > Math.abs(dy)) {
			doMove(dx > 0 ? 1 : 3)
		} else {
			doMove(dy > 0 ? 2 : 0)
		}
	}, { passive: true })

	document.getElementById('tfe-new').addEventListener('click', newGame)
	document.getElementById('tfe-retry').addEventListener('click', newGame)
	els.keepGoing.addEventListener('click', function () {
		keepPlaying = true
		updateMessage()
	})

	// Don't lose a score that is still waiting for its debounce.
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'hidden' && game) {
			scheduleSubmit(true)
		}
	})

	// --- start ---

	var saved = loadLocal()
	game = saved ? Core.createGame(null, saved) : Core.createGame()
	render()
	saveLocal()
	refreshLeaderboard().then(function () {
		// Catch up a score that was never sent (offline, closed tab, …).
		scheduleSubmit(false)
	})
})()

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// The fixture implements DOM events, focus and element children without adding
// browser dependencies to the app's plain JavaScript build.
function fixture() {
	const selectors = new Map()
	const document = {
		listeners: {},
		activeElement: null,
		addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener) },
		dispatch(type, event) { for (const listener of this.listeners[type] || []) listener(event) },
		querySelector(selector) { return (selectors.get(selector) || [])[0] || null },
		querySelectorAll(selector) { return selector.split(', ').flatMap(part => selectors.get(part) || []) },
		getElementsByClassName(name) { return selectors.get('.' + name) || [] },
		createElement(tag) { return new Element(tag) },
		getElementById(id) { return this.querySelector('#' + id) },
	}
	class Element {
		constructor(tag = 'div', className = '') {
			this.tagName = tag.toUpperCase()
			this.className = className
			this.children = []
			this.attributes = {}
			this.listeners = {}
			this.disabled = false
			this.tabIndex = -1
			this._text = ''
			this.classList = {
				contains: name => this.className.split(' ').includes(name),
				add: name => { if (!this.classList.contains(name)) this.className += ' ' + name },
				remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' ') },
			}
		}
		set textContent(value) { this._text = String(value); this.children = [] }
		get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
		get firstChild() { return this.children[0] || null }
		setAttribute(name, value) { this.attributes[name] = String(value) }
		getAttribute(name) { return this.attributes[name] ?? null }
		addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener) }
		dispatch(type, event = {}) {
			event.target ||= this
			event.preventDefault ||= function () { this.defaultPrevented = true }
			for (const listener of this.listeners[type] || []) listener(event)
		}
		appendChild(child) { child.parentNode = this; this.children.push(child) }
		removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null }
		focus() { document.activeElement = this; this.dispatch('focus') }
		querySelector(selector) { return this.children.find(child => child.classList.contains(selector.slice(1))) || null }
		getBoundingClientRect() { return this.rect }
		getClientRects() { return this.hidden ? [] : [{}] }
		contains(element) { return this === element || this.children.some(child => child.contains(element)) }
	}
	function element(selector, tag = 'div') {
		const value = new Element(tag, selector.slice(1))
		selectors.set(selector, [value])
		return value
	}
	const root = element('#tfe')
	document.documentElement = new Element('html')
	document.body = new Element('body')
	document.documentElement.appendChild(document.body)
	document.body.appendChild(root)
	const container = element('.game-container')
	root.appendChild(container)
	const score = element('.score-container', 'output')
	score.textContent = '0'
	root.appendChild(score)
	const tiles = element('.tile-container')
	container.appendChild(tiles)
	const hint = element('.bonus-hint', 'p')
	const controls = {}
	for (const action of ['retry', 'restart', 'keep-playing']) {
		controls[action] = element('.' + action + '-button', 'button')
		root.appendChild(controls[action])
	}
	const cells = Array.from({ length: 16 }, (_, index) => {
		const cell = new Element('div', 'grid-cell')
		const x = index % 4, y = Math.floor(index / 4)
		cell.rect = { left: x * 100, top: y * 100, right: x * 100 + 90, bottom: y * 100 + 90 }
		container.appendChild(cell)
		return cell
	})
	selectors.set('.grid-cell', cells)
	const buttons = {}
	for (const type of ['undo', 'swap', 'remove']) {
		const button = new Element('button', 'bonus-button')
		button.setAttribute('data-bonus', type)
		button.appendChild(new Element('span', 'bonus-count'))
		buttons[type] = button
		root.appendChild(button)
	}
	selectors.set('.bonus-button', Object.values(buttons))
	const ctx = vm.createContext({ document, window: { navigator: {}, getComputedStyle: element => element.style || {}, requestAnimationFrame: callback => callback() } })
	for (const file of ['keyboard_input_manager', 'bonus_ui', 'leaderboard', 'html_actuator']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), ctx)
	}
	const input = new ctx.KeyboardInputManager()
	const actions = []
	const board = [[2, 4, 0, 0], [8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
	const game = {
		size: 4,
		bonuses: { undo: 2, swap: 2, remove: 2 },
		grid: { cellContent: ({ x, y }) => board[y][x] ? { value: board[y][x] } : null },
		canUseBonus(type) { return this.bonuses[type] > 0 },
		undo() { actions.push(['undo']); return true },
		swapTiles(a, b) { actions.push(['swap', a.x, a.y, b.x, b.y]); return true },
		removeTilesOfValue(value) { actions.push(['remove', value]); return true },
	}
	const ui = new ctx.BonusUI(game)
	input.on('tap', point => ui.tap(point))
	input.on('move', direction => actions.push(['move', direction]))
	input.on('restart', () => actions.push(['restart']))
	input.on('keepPlaying', () => actions.push(['keepPlaying']))
	ui.update()
	function key(key, which, target = document.activeElement) {
		const event = { key, which, target, preventDefault() { this.defaultPrevented = true } }
		document.dispatch('keydown', event)
		return event
	}
	return { document, ctx, Element, selectors, root, score, controls, buttons, cells, container, hint, game, ui, actions, key }
}

test('game actions use native buttons and expose live status and board cells', () => {
	const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'main.php'), 'utf8')
	for (const action of ['restart', 'retry', 'keep-playing']) {
		assert.match(template, new RegExp('<button type="button" class="' + action + '-button"'))
	}
	assert.match(template, /class="tfe-status" role="status" aria-live="polite"/)
	assert.match(template, /role="gridcell" tabindex="-1"/)
	assert.match(template, /<span class="score-label" id="tfe-score-label">Score<\/span>/)
	assert.match(template, /<output class="score-container" aria-labelledby="tfe-score-label"[^>]*>0<\/output>/)
})

test('Swap selects two tiles with arrows and Enter/Space without moving the game', () => {
	const env = fixture()
	env.buttons.swap.focus()
	env.buttons.swap.dispatch('click')
	assert.equal(env.document.activeElement, env.cells[0])
	assert.equal(env.cells.filter(cell => cell.tabIndex === 0).length, 1)
	assert.equal(env.buttons.swap.getAttribute('aria-pressed'), 'true')
	assert.equal(env.key('Enter', 13).defaultPrevented, true)
	assert.equal(env.cells[0].getAttribute('aria-selected'), 'true')
	env.key('ArrowRight', 39)
	assert.equal(env.document.activeElement, env.cells[1])
	env.key(' ', 32)
	assert.deepEqual(env.actions, [['swap', 0, 0, 1, 0]])
	assert.equal(env.ui.mode, null)
	assert.equal(env.document.activeElement, env.buttons.swap)
	assert.equal(env.buttons.swap.getAttribute('aria-pressed'), 'false')
})

test('Remove ignores empty cells and Escape returns focus to the bonus button', () => {
	const env = fixture()
	env.buttons.remove.dispatch('click')
	env.key('ArrowRight', 39)
	env.key('ArrowRight', 39)
	env.key('Enter', 13)
	assert.deepEqual(env.actions, [])
	assert.equal(env.ui.mode, 'remove')
	env.key('r', 82)
	assert.deepEqual(env.actions, [])
	env.key('Escape', 27)
	assert.equal(env.document.activeElement, env.buttons.remove)
	assert.equal(env.ui.mode, null)
	env.key('ArrowDown', 40)
	assert.deepEqual(env.actions, [['move', 2]])
	env.buttons.remove.dispatch('click')
	env.key('ArrowDown', 40)
	env.key('Enter', 13)
	assert.deepEqual(env.actions, [['move', 2], ['remove', 8]])
})

test('rejected swap keeps selection mode and announces the refusal', () => {
	const env = fixture()
	env.game.swapTiles = () => false
	env.buttons.swap.dispatch('click')
	env.key('Enter', 13)
	env.key('ArrowRight', 39)
	env.key('Enter', 13)
	assert.equal(env.ui.mode, 'swap')
	assert.equal(env.ui.selected, null)
	assert.match(env.hint.textContent, /would end the game/)
})

test('mouse clicks and touch taps still select bonus tiles; swipes in bonus mode do not move', () => {
	const env = fixture()
	env.buttons.swap.dispatch('click')
	env.container.dispatch('click', { clientX: 45, clientY: 45 })
	function touch(type, x, y) {
		env.container.dispatch(type, {
			touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
			targetTouches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
			changedTouches: [{ clientX: x, clientY: y }],
		})
	}
	touch('touchstart', 45, 45)
	touch('touchend', 245, 45)
	assert.deepEqual(env.actions, [])
	touch('touchstart', 145, 45)
	touch('touchend', 145, 45)
	assert.deepEqual(env.actions, [['swap', 0, 0, 1, 0]])
	touch('touchstart', 45, 45)
	touch('touchend', 245, 45)
	assert.deepEqual(env.actions, [['swap', 0, 0, 1, 0], ['move', 1]])
})

test('native button clicks are single actions and game swipes leave touch controls alone', () => {
	const env = fixture()
	env.container.appendChild(env.controls.retry)
	for (const type of ['touchstart', 'touchend']) {
		const event = { target: env.controls.retry }
		env.container.dispatch(type, event)
		assert.equal(event.defaultPrevented, undefined)
	}
	env.controls.retry.dispatch('click')
	env.controls.restart.dispatch('click')
	env.controls['keep-playing'].dispatch('click')
	assert.deepEqual(env.actions, [['restart'], ['restart'], ['keepPlaying']])
	assert.equal(env.document.activeElement, null)
})

test('game shortcuts leave navigation controls, dialogs and text editing alone', () => {
	const env = fixture()
	const navigation = new env.Element('button')
	const dialog = new env.Element('div')
	const input = new env.Element('input')
	const editable = new env.Element('div')
	editable.isContentEditable = true
	env.root.appendChild(input)
	env.root.appendChild(editable)
	for (const target of [navigation, dialog, input, editable]) {
		assert.equal(env.key('ArrowRight', 39, target).defaultPrevented, undefined)
		assert.equal(env.key('r', 82, target).defaultPrevented, undefined)
	}
	assert.deepEqual(env.actions, [])
	for (const target of [env.document.body, env.document.documentElement, env.controls.restart]) {
		env.key('ArrowRight', 39, target)
	}
	assert.deepEqual(env.actions, [['move', 1], ['move', 1], ['move', 1]])
})

test('a visible external modal suppresses shortcuts even when body or the game has focus', () => {
	const env = fixture()
	const dialog = new env.Element('div')
	env.document.body.appendChild(dialog)
	env.selectors.set('[role="dialog"][aria-modal="true"]', [dialog])
	for (const target of [env.document.body, env.cells[0], dialog]) {
		env.key('ArrowLeft', 37, target)
		env.key('r', 82, target)
	}
	assert.deepEqual(env.actions, [])
	dialog.hidden = true
	env.key('ArrowLeft', 37, env.document.body)
	assert.deepEqual(env.actions, [['move', 3]])
	dialog.hidden = false
	dialog.style = { visibility: 'hidden' }
	env.key('ArrowLeft', 37, env.document.body)
	assert.deepEqual(env.actions, [['move', 3], ['move', 3]])
})

test('bonus selection does not steal keys from navigation controls or external modals', () => {
	const env = fixture()
	env.buttons.swap.dispatch('click')
	const navigation = new env.Element('button')
	env.key('ArrowRight', 39, navigation)
	env.key('Escape', 27, navigation)
	assert.equal(env.document.activeElement, env.cells[0])
	assert.equal(env.ui.mode, 'swap')
	const dialog = new env.Element('div')
	env.selectors.set('[role="dialog"][aria-modal="true"]', [dialog])
	env.key('ArrowRight', 39, env.cells[0])
	env.key('Enter', 13, env.cells[0])
	assert.equal(env.document.activeElement, env.cells[0])
	assert.equal(env.ui.selected, null)
	assert.deepEqual(env.actions, [])
})

test('loading disables controls and bonus selection; board labels announce tile values', () => {
	const env = fixture()
	assert.equal(env.cells[0].getAttribute('aria-label'), 'Row 1, column 1: 2')
	assert.equal(env.cells[2].getAttribute('aria-label'), 'Row 1, column 3: empty')
	assert.equal(env.buttons.remove.getAttribute('aria-label'), 'Remove: 2 charges')
	env.game.initializing = true
	env.ui.update()
	for (const control of [...Object.values(env.controls), ...Object.values(env.buttons)]) assert.equal(control.disabled, true)
	env.buttons.swap.dispatch('click')
	assert.equal(env.ui.mode, null)
	assert.deepEqual(env.actions, [])
	env.game.initializing = false
	env.ui.update()
	assert.equal(env.controls.restart.disabled, false)
	env.game.grid = null
	env.ui.update()
	assert.equal(env.controls.restart.disabled, false, 'a failed start can be retried')
	assert.equal(env.controls['keep-playing'].disabled, true)
	env.buttons.swap.dispatch('click')
	assert.equal(env.ui.mode, null)
})

test('Keep going is enabled only on a won game that can be continued', () => {
	const env = fixture()
	assert.equal(env.controls['keep-playing'].disabled, true)
	env.game.won = true
	env.ui.update()
	assert.equal(env.controls['keep-playing'].disabled, false)
	env.game.keepPlaying = true
	env.ui.update()
	assert.equal(env.controls['keep-playing'].disabled, true)
})

test('spent bonus returns focus to an enabled game control', () => {
	const env = fixture()
	env.game.removeTilesOfValue = () => {
		env.game.bonuses.remove = 0
		env.ui.update()
		return true
	}
	env.buttons.remove.dispatch('click')
	env.key('Enter', 13)
	assert.equal(env.buttons.remove.disabled, true)
	assert.equal(env.document.activeElement, env.controls.restart)
})

test('leaderboard uses API competition ranks for ties and renders names as text', () => {
	const env = fixture()
	const list = new env.Element('ol')
	const me = new env.Element('p')
	const empty = new env.Element('p')
	const leaderboard = new env.ctx.Leaderboard(list, me, empty)
	leaderboard.render({
		leaderboard: [
			{ rank: 1, score: 100, displayName: 'Alice', bestTile: 32 },
			{ rank: 1, score: 100, displayName: '<script>alert(1)</script>', isMe: true },
			{ rank: 3, score: 50, displayName: 'Charlie', bestTile: 16 },
		],
		me: { rank: 1, score: 100 },
	})
	assert.deepEqual(list.children.map(item => item.children[0].textContent), ['1', '1', '3'])
	assert.deepEqual(list.children.map(item => item.value), [1, 1, 3])
	assert.equal(list.children[1].children[1].textContent, '<script>alert(1)</script>')
	assert.equal(list.children[1].children[1].children.length, 0)
	assert.equal(list.children[1].className, 'tfe-mine')
	assert.equal(me.textContent, 'Your place: #1 (100)')
	assert.equal(empty.hidden, true)
	leaderboard.render({ leaderboard: [], me: null })
	assert.equal(list.children.length, 0)
	assert.equal(empty.hidden, false)
	assert.equal(me.textContent, 'You have no score yet.')
})


test('current score updates and resets while gain animations are hidden from screen readers', () => {
	const env = fixture()
	const actuator = new env.ctx.HTMLActuator()
	actuator.updateScore(16)
	assert.equal(env.score._text, '16')
	assert.equal(env.score.children.length, 1)
	assert.equal(env.score.children[0].textContent, '+16')
	assert.equal(env.score.children[0].getAttribute('aria-hidden'), 'true')
	actuator.updateScore(24)
	assert.equal(env.score._text, '24')
	assert.equal(env.score.children.length, 1)
	assert.equal(env.score.children[0].textContent, '+8')
	actuator.updateScore(0)
	assert.equal(env.score.textContent, '0')
	assert.equal(env.score.children.length, 0)
})

test('application does not expose background saving status in the game UI', () => {
	const env = fixture()
	const statuses = []
	let gamesCreated = 0
	env.ctx.GameManager = function () {
		gamesCreated++
		this.initializing = false
		this.setStatus = message => statuses.push(message)
	}
	env.ctx.ServerStorageManager = function () {}
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'application.js'), 'utf8'), env.ctx)
	assert.equal(gamesCreated, 1)
	for (const message of ['Saved', 'Offline', 'Saving failed']) {
		env.root.dispatch('tfe:storage-status', { detail: { message } })
	}
	assert.deepEqual(statuses, [])
})

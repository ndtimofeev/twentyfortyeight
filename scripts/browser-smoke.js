const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const stateFields = ['grid', 'score', 'over', 'won', 'keepPlaying', 'moves', 'maxTile',
  'bonuses', 'reached', 'previous', 'randomState', 'peakScore'];
function boardState(state) {
  return Object.fromEntries(stateFields.filter(key => key in state).map(key => [key, state[key]]));
}
async function readState(page) {
  return page.evaluate(() => {
    const root=document.querySelector('#tfe');
    const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
    return JSON.parse(localStorage.getItem(key));
  });
}
async function activeGame(page) {
  return page.evaluate(async () => {
    const root=document.querySelector('#tfe');
    const response=await fetch(root.dataset.gamesUrl, {headers:{
      requesttoken:document.head.dataset.requesttoken,
      'X-Requested-With':'XMLHttpRequest',
      Accept:'application/json',
    }});
    if (!response.ok) throw new Error('GET active game failed: '+response.status);
    return (await response.json()).game;
  });
}
async function waitSaved(page, expected) {
  const deadline=Date.now()+15000;
  while (Date.now()<deadline) {
    const game=await activeGame(page);
    const local=await readState(page);
    if (game && local && game.session.token===expected.session.token &&
      JSON.stringify(game.actions)===JSON.stringify(expected.actions) && local.revision===game.revision) {
      assert.deepEqual(boardState(game.state),boardState(local),'server and browser save the complete same board');
      return game;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('The active game did not reach the browser history on the server');
}
async function waitReady(page) {
  await page.waitForFunction(() => {
    const root=document.querySelector('#tfe');
    if (!root || document.querySelectorAll('#tfe .tile').length<2) return false;
    const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
    const state=JSON.parse(localStorage.getItem(key));
    return state && state.session && Number(document.querySelector('.score-container').firstChild.textContent)===state.score;
  });
}
async function assertRendered(page,state) {
  await page.waitForFunction(score => Number(document.querySelector('.score-container').firstChild.textContent)===score,state.score);
  const values=await page.locator('.grid-cell').evaluateAll(cells => cells.map(cell => Number(cell.dataset.value)));
  const expected=[];
  for (let y=0;y<4;y++) for (let x=0;x<4;x++) expected.push(state.grid.cells[x][y] ? state.grid.cells[x][y].value : 0);
  assert.deepEqual(values,expected,'rendered board matches the canonical board');
  for (const bonus of ['undo','swap','remove']) {
    assert.equal(Number(await page.locator('[data-bonus='+bonus+'] .bonus-count').textContent()),state.bonuses[bonus]);
  }
}
async function login(context, base, errors) {
  const page=await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base+'/index.php/login');
  await page.locator('input[name=user]').fill('smoke-two');
  await page.locator('input[name=password]').fill(process.env.TEST_NEXTCLOUD_PASSWORD);
  await page.locator('button[type=submit], input[type=submit]').first().click();
  await page.waitForURL(/\/apps\//,{timeout:30000});
  await page.goto(base+'/index.php/apps/twentyfortyeight/');
  await waitReady(page);
  return page;
}
(async () => {
  const browser = await chromium.launch({executablePath:process.env.TEST_CHROMIUM_EXECUTABLE || undefined,headless:true,args:['--no-sandbox']});
  try {
    const errors = [];
    const base = process.argv[2];
    const firstContext=await browser.newContext();
    const page=await login(firstContext,base,errors);
    assert.equal(await page.locator('.restart-button').evaluate(el=>el.tagName), 'BUTTON');
    const directionKeys = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'];
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press(directionKeys[step % 4]);
      if (await page.locator('.score-container').evaluate(el => Number(el.firstChild.textContent)) > 0) break;
    }
    await page.waitForFunction(() => {
      const root=document.querySelector('#tfe');
      const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      const state=JSON.parse(localStorage.getItem(key));
      return state && state.actions.length>=1;
    });
    const saved=await readState(page);
    assert(saved.session.token && saved.randomState>0);
    assert(saved.score > 0);
    await page.waitForFunction(score => Number(document.querySelector('.score-container').firstChild.textContent) === score, saved.score);
    const earlierCanonical=await waitSaved(page,saved);
    await page.reload();
    await waitReady(page);
    const restored=await readState(page);
    assert.deepEqual(boardState(restored),boardState(saved));
    assert.deepEqual(restored.actions,saved.actions);
    await assertRendered(page,saved);
    console.log('Browser: saved board restored after reload.');

    // A new browser profile has no localStorage from the first device.
    const secondContext=await browser.newContext();
    const secondPage=await login(secondContext,base,errors);
    const remoteRestored=await readState(secondPage);
    assert.equal(remoteRestored.session.token,saved.session.token);
    assert.deepEqual(remoteRestored.actions,saved.actions);
    assert.deepEqual(boardState(remoteRestored),boardState(saved),'a second device restores RNG, bonuses and Undo as well as tiles');
    await assertRendered(secondPage,saved);
    assert.equal(await secondPage.locator('[data-bonus=undo]').isEnabled(),true);
    console.log('Browser: second device restored the complete board.');
    let advanced;
    for (const key of directionKeys) {
      await secondPage.keyboard.press(key);
      const candidate=await readState(secondPage);
      if (candidate.actions.length>saved.actions.length) { advanced=candidate; break; }
    }
    assert(advanced,'the second device made a successful move');
    const canonical=await waitSaved(secondPage,advanced);
    // Deliver an earlier read during focus refresh, as if it started before the
    // second device committed. The write still reaches the actual server.
    const delayedRead=async route => {
      if (route.request().method()==='GET') {
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({game:earlierCanonical})});
      } else await route.continue();
    };
    await page.route('**/api/games',delayedRead);
    const staleConflict=page.waitForResponse(response => response.request().method()==='PUT' &&
      response.url().includes('/api/games') && response.status()===409,{timeout:15000});
    await page.locator('[data-bonus=undo]').click();
    await staleConflict;
    await page.unroute('**/api/games',delayedRead);
    await page.waitForFunction(expected => {
      const root=document.querySelector('#tfe');
      const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      const state=JSON.parse(localStorage.getItem(key));
      return state && JSON.stringify(state.actions)===JSON.stringify(expected.actions) && state.revision===expected.revision;
    },canonical);
    assert.deepEqual(boardState(await readState(page)),boardState(canonical.state),'a stale browser restores the winning history');
    await assertRendered(page,canonical.state);
    assert.deepEqual(await activeGame(page),canonical,'a stale browser cannot overwrite the second device');
    console.log('Browser: stale write rejected and current board restored.');
    await page.reload();
    await waitReady(page);
    const afterReload=await readState(page);
    assert.deepEqual(boardState(afterReload),boardState(canonical.state));
    assert.deepEqual(afterReload.actions,canonical.actions);

    // Ordinary focus refresh must load newer moves without a local move first.
    await secondPage.bringToFront();
    let newer;
    for (const key of directionKeys) {
      await secondPage.keyboard.press(key);
      const candidate=await readState(secondPage);
      if (candidate.actions.length>canonical.actions.length) { newer=candidate; break; }
    }
    assert(newer,'the second device made another move');
    const latest=await waitSaved(secondPage,newer);
    await page.bringToFront();
    // Headless contexts use separate windows; activating one does not reliably
    // emit a browser window focus event, so exercise the registered handler explicitly.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(expected => {
      const root=document.querySelector('#tfe');
      const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      const state=JSON.parse(localStorage.getItem(key));
      return state && JSON.stringify(state.actions)===JSON.stringify(expected.actions) && state.revision===expected.revision;
    },latest);
    assert.deepEqual(boardState(await readState(page)),boardState(latest.state),'focus refresh restores another device\'s latest board');
    await assertRendered(page,latest.state);
    console.log('Browser: focus refresh loaded the second device\'s next move.');
    await page.reload();
    await waitReady(page);
    const synchronized=await readState(page);
    assert.deepEqual(boardState(synchronized),boardState(latest.state));
    assert.deepEqual(synchronized.actions,latest.actions);
    await secondContext.close();
    await page.locator('[data-bonus=undo]').click();
    await page.waitForFunction(score => Number(document.querySelector('.score-container').firstChild.textContent) === score, synchronized.previous.score);
    await page.locator('[data-bonus=remove]').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('.game-container').evaluate(el=>el.classList.contains('bonus-mode')));
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')), 'gridcell');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.bonus), 'remove');
    await page.locator('[data-bonus=remove]').click();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-bonus=remove] .bonus-count').textContent(), '1');
    await page.locator('.restart-button').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(oldToken => {
      const root=document.querySelector('#tfe');
      const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      const state=JSON.parse(localStorage.getItem(key));
      return state && state.session.token!==oldToken && state.actions.length===0;
    }, saved.session.token);
    await page.waitForTimeout(1700);
    await page.waitForFunction(() => Number(document.querySelector('.score-container').firstChild.textContent) === 0);
    await page.evaluate(() => document.getElementById('tfe').dispatchEvent(new CustomEvent('tfe:storage-status', {
      detail: {state: 'saved', message: 'Result saved.'}
    })));
    assert.equal(await page.locator('.tfe-status').textContent(), '');

    const mobileBoards = [];
    for (const width of [320, 390, 430, 700, 1280]) {
      await page.setViewportSize({width, height: 640});
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const root = document.querySelector('#tfe');
        const board = document.querySelector('.game-container').getBoundingClientRect();
        const game = document.querySelector('#tfe-game').getBoundingClientRect();
        const ranking = document.querySelector('.tfe-leaderboard').getBoundingClientRect();
        const header = document.querySelector('.above-game').getBoundingClientRect();
        const cells = Array.from(document.querySelectorAll('.grid-cell'));
        const tiles = document.querySelector('.tile-container');
        let alignmentError = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
          const probe = document.createElement('div');
          probe.className = 'tile tile-position-' + (x+1) + '-' + (y+1);
          probe.style.transition = 'none';
          tiles.appendChild(probe);
          const tile = probe.getBoundingClientRect();
          const cell = cells[y * 4 + x].getBoundingClientRect();
          alignmentError = Math.max(alignmentError, Math.abs(tile.left-cell.left), Math.abs(tile.top-cell.top),
            Math.abs(tile.width-cell.width), Math.abs(tile.height-cell.height));
          probe.remove();
        }
        return {width: board.width, height: board.height, left: board.left, right: board.right,
          rankingTop: ranking.top, gameBottom: game.bottom, headerBottom: header.bottom, boardTop: board.top,
          horizontalOverflow: root.scrollWidth-root.clientWidth, alignmentError};
      });
      assert(Math.abs(layout.width-layout.height)<1, 'square board at '+width);
      assert(layout.left>=0 && layout.right<=width+1, 'board fits at '+width);
      assert(layout.horizontalOverflow<=1, 'no horizontal overflow at '+width);
      assert(layout.alignmentError<1, 'tile/cell alignment at '+width+': '+JSON.stringify(layout));
      assert(layout.headerBottom<layout.boardTop, 'score is above board at '+width);
      if (width<=700) assert(layout.rankingTop>=layout.gameBottom, 'leaderboard is below the game at '+width);
      if (width<=430) {
        assert(Math.abs(layout.left-16)<2 && Math.abs(width-layout.right-16)<2,
          'mobile board has 16px side margins at '+width+': '+JSON.stringify(layout));
        assert(layout.width>=width-34, 'mobile board uses available width at '+width+': '+JSON.stringify(layout));
        mobileBoards.push(width+'→'+Math.round(layout.width));
      }
      if (width===390) {
        await page.locator('.above-game').hover();
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(250);
        const ranking = await page.locator('.tfe-leaderboard').boundingBox();
        assert(ranking.y<640 && ranking.y+ranking.height>0, 'leaderboard can be scrolled into view');
        await page.locator('.score-container').scrollIntoViewIfNeeded();
      }
      if (process.env.TEST_UI_SCREENSHOT_DIR && (width===390 || width===1280)) {
        await page.screenshot({path: process.env.TEST_UI_SCREENSHOT_DIR+'/'+width+'.png'});
      }
    }
    console.log('Mobile board widths: '+mobileBoards.join(', '));
    assert.deepEqual(errors, []);
    console.log('Browser cross-device restore/conflicts, score/reload/Undo, silent saving, mobile geometry/scrolling, keyboard bonuses and restart passed.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e.stack || e.message);process.exitCode=1;});

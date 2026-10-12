const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.TEST_CHROMIUM_EXECUTABLE || undefined,headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = process.argv[2];
    await page.goto(base+'/index.php/login');
    await page.locator('input[name=user]').fill('smoke-two');
    await page.locator('input[name=password]').fill(process.env.TEST_NEXTCLOUD_PASSWORD);
    await page.locator('button[type=submit], input[type=submit]').first().click();
    await page.waitForURL(/\/apps\//, {timeout:30000});
    await page.goto(base+'/index.php/apps/twentyfortyeight/');
    await page.waitForFunction(() => document.querySelectorAll('#tfe .tile').length===2);
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
    const saved = await page.evaluate(() => {
      const root=document.querySelector('#tfe');
      const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      return JSON.parse(localStorage.getItem(key));
    });
    assert(saved.session.token && saved.randomState>0);
    assert(saved.score > 0);
    await page.waitForFunction(score => Number(document.querySelector('.score-container').firstChild.textContent) === score, saved.score);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#tfe .tile').length>=2);
    const restored = await page.evaluate(() => {
      const root=document.querySelector('#tfe');
      const key='twentyfortyeight.gameState.'+encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      return JSON.parse(localStorage.getItem(key));
    });
    assert.deepEqual(restored.grid,saved.grid);
    assert.deepEqual(restored.actions,saved.actions);
    assert.equal(restored.randomState,saved.randomState);
    await page.waitForFunction(score => Number(document.querySelector('.score-container').firstChild.textContent) === score, saved.score);
    await page.locator('[data-bonus=undo]').click();
    await page.waitForFunction(score => Number(document.querySelector('.score-container').firstChild.textContent) === score, saved.previous.score);
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
        assert(layout.width>=width-48, 'mobile board uses available width at '+width+': '+JSON.stringify(layout));
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
    console.log('Browser score/reload/Undo, silent saving, mobile geometry/scrolling, keyboard bonuses and restart passed.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});

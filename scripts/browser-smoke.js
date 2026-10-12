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
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
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
    assert.deepEqual(errors, []);
    console.log('Browser startup, signed actions, seeded reload, keyboard bonuses and restart passed.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});

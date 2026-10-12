const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createGame,chooseMove,apply}=require('../tests/generate_replay_fixtures');
const stateFields = ['grid', 'score', 'over', 'won', 'keepPlaying', 'moves', 'maxTile',
  'bonuses', 'pendingBonuses', 'reached', 'previous', 'randomState', 'peakScore'];
const copy=value => JSON.parse(JSON.stringify(value));
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
async function login(context, base, errors, username='smoke-two') {
  const page=await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base+'/index.php/login');
  await page.locator('input[name=user]').fill(username);
  await page.locator('input[name=password]').fill(process.env.TEST_NEXTCLOUD_PASSWORD);
  await page.locator('button[type=submit], input[type=submit]').first().click();
  await page.waitForURL(/\/apps\//,{timeout:30000});
  await page.goto(base+'/index.php/apps/twentyfortyeight/');
  await waitReady(page);
  return page;
}
function fixtureState(env) {
  return copy({...env.game.serialize(),peakScore:env.stored.peakScore});
}
function fixtureAction(env,action) {
  const before=env.stored.actions.length;
  apply(env,action);
  assert.equal(env.stored.actions.length,before+1,'Every planned milestone action must succeed');
  return fixtureState(env);
}
function first128Plan(seed) {
  const env=createGame(seed,null,null,3);
  const steps=[];
  for (let move=0;move<1000 && !env.game.reached[128];move++) {
    assert.equal(env.game.over,false,'The solver must reach the first 128 before losing');
    const direction=chooseMove(env.game);
    assert.notEqual(direction,null);
    const action=['move',direction];
    steps.push({action,state:fixtureAction(env,action)});
  }
  assert.equal(Boolean(env.game.reached[128]),true);
  assert.equal(env.game.bonuses.undo,2);
  assert.equal('pendingBonuses' in fixtureState(env),false,'Modern games must not bank rewards');
  return {env,steps};
}
async function playFixtureAction(page,action) {
  if (action[0]==='undo') await page.locator('[data-bonus=undo]').click();
  else {
    // A still-focused bonus button intentionally owns arrows; return them to the board.
    await page.evaluate(() => {document.activeElement.blur();document.body.focus();});
    await page.keyboard.press(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft'][action[1]]);
  }
}
async function assertFixtureState(page,expected) {
  const actual=await readState(page);
  assert.deepEqual(boardState(actual),boardState(expected),'The genuine browser game must match the planned seeded game');
  await assertRendered(page,expected);
  return actual;
}
async function captureGameManager(context) {
  await context.addInitScript(() => {
    let installed=false;
    function install() {
      if (installed || !document.querySelector('#tfe') || typeof window.GameManager!=='function') return;
      installed=true;
      const Original=window.GameManager;
      window.GameManager=function(...args) {
        const game=new Original(...args);
        window.__tfeTestGame=game;
        return game;
      };
      window.GameManager.prototype=Original.prototype;
    }
    const requestFrame=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=callback => requestFrame(time => {
      install();
      callback.call(window,time);
    });
    document.addEventListener('DOMContentLoaded',install,{once:true});
  });
}
async function managedState(page) {
  return page.evaluate(() => {
    const game=window.__tfeTestGame;
    const storage=game.storageManager;
    return {...game.serialize(),session:storage.session,actions:storage.actions,
      revision:storage.gameRevision,peakScore:storage.gamePeakScore};
  });
}
async function waitManagedReady(page) {
  await page.waitForFunction(() => {
    const game=window.__tfeTestGame;
    return game && !game.initializing && game.grid && game.storageManager.session &&
      Number(document.querySelector('.score-container').firstChild.textContent)===game.score;
  });
}
function deferred() {
  let resolve;
  const promise=new Promise(done => {resolve=done;});
  return {promise,resolve};
}
async function bounded(promise,label) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject) => {
      timer=setTimeout(() => reject(new Error('Timed out waiting for '+label)),15000);
    })]);
  } finally {clearTimeout(timer);}
}
async function sharedDraftRegression(browser,base,errors) {
  const context=await browser.newContext();
  const releaseShortAck=deferred();
  const releaseLongRequest=deferred();
  try {
    await captureGameManager(context);
    const first=await login(context,base,errors);
    await waitManagedReady(first);
    const previous=await managedState(first);
    await first.locator('.restart-button').click();
    await first.waitForFunction(oldToken => {
      const game=window.__tfeTestGame;
      return game && !game.initializing && game.storageManager.session &&
        game.storageManager.session.token!==oldToken && game.storageManager.actions.length===0;
    },previous.session.token);
    await waitManagedReady(first);
    const initial=await managedState(first);
    assert.equal(initial.session.version,3);
    await waitSaved(first,initial);
    const env=createGame(initial.session.seed,null,null,initial.session.version);
    assert.deepEqual(boardState(initial),boardState(fixtureState(env)));

    // The first write reaches the real server; only its HTTP response is delayed.
    const shortCommitted=deferred();
    let shortGame;
    let shortError;
    let firstPut=true;
    await first.route('**/api/games',async route => {
      if (route.request().method()==='PUT' && firstPut) {
        firstPut=false;
        try {
          const response=await route.fetch();
          assert.equal(response.status(),200);
          shortGame=(await response.json()).game;
          shortCommitted.resolve();
          await releaseShortAck.promise;
          await route.fulfill({response});
        } catch (error) {
          shortError=error;
          shortCommitted.resolve();
          await route.abort().catch(() => {});
        }
      } else if (shortGame) {
        // Later focus refreshes/retries must not supply the second tab's tail.
        await route.abort('internetdisconnected');
      } else await route.continue();
    });
    const firstAction=['move',chooseMove(env.game)];
    assert.notEqual(firstAction[1],null);
    const shortExpected=fixtureAction(env,firstAction);
    await playFixtureAction(first,firstAction);
    assert.deepEqual(boardState(await managedState(first)),boardState(shortExpected));
    await bounded(shortCommitted.promise,'the short history to commit on the server');
    if (shortError) throw shortError;
    assert.equal(shortGame.actions.length,1);
    assert.deepEqual(boardState(shortGame.state),boardState(shortExpected));

    const second=await context.newPage();
    second.on('pageerror',error => errors.push(error.message));
    const longPending=deferred();
    let longBody;
    let apiOffline=false;
    let firstLongPut=true;
    const secondGames=async route => {
      if (route.request().method()==='PUT' && firstLongPut) {
        firstLongPut=false;
        longBody=route.request().postDataJSON();
        longPending.resolve();
        // Keep this compatible tail local until after the offline reload.
        await releaseLongRequest.promise;
        await route.abort('internetdisconnected').catch(() => {});
      } else if (apiOffline) await route.abort('internetdisconnected');
      else await route.continue();
    };
    const offlineScores=route => route.abort('internetdisconnected');
    await second.route('**/api/games',secondGames);
    await second.goto(base+'/index.php/apps/twentyfortyeight/');
    await waitManagedReady(second);
    const restoredShort=await managedState(second);
    assert.deepEqual(restoredShort.actions,shortGame.actions);
    assert.deepEqual(boardState(restoredShort),boardState(shortExpected));
    apiOffline=true;
    await second.route('**/api/scores**',offlineScores);
    const secondAction=['move',chooseMove(env.game)];
    assert.notEqual(secondAction[1],null);
    const longExpected=fixtureAction(env,secondAction);
    await playFixtureAction(second,secondAction);
    const longer=await managedState(second);
    assert.deepEqual(boardState(longer),boardState(longExpected));
    assert.equal(longer.actions.length,2);
    await bounded(longPending.promise,'the longer compatible local history to attempt saving');
    assert.deepEqual(longBody.actions,longer.actions);
    assert.equal(longBody.revision,shortGame.revision);

    // Page routes do not intercept APIRequestContext, so this checks the actual
    // server independently while both browser writes are held.
    const api=await second.evaluate(() => ({url:document.querySelector('#tfe').dataset.gamesUrl,
      token:document.head.dataset.requesttoken}));
    const serverResponse=await context.request.get(new URL(api.url,base).href,{headers:{
      requesttoken:api.token,'X-Requested-With':'XMLHttpRequest',Accept:'application/json',
    }});
    assert.equal(serverResponse.status(),200);
    const stillShort=(await serverResponse.json()).game;
    assert.deepEqual(stillShort.actions,shortGame.actions,'The longer tail must not already exist on the server');

    const lateAck=first.waitForResponse(response => response.request().method()==='PUT' &&
      response.url().includes('/api/games') && response.status()===200,{timeout:15000});
    releaseShortAck.resolve();
    await lateAck;
    await first.evaluate(async () => {
      const pending=window.__tfeTestGame.storageManager.gameInFlight;
      if (pending) await pending;
    });
    const recoverable=await second.evaluate(() => window.__tfeTestGame.storageManager.getGameState());
    assert.deepEqual(recoverable.actions,longer.actions,'A late short ACK must preserve the longer recoverable shared draft');
    assert.deepEqual(boardState(recoverable),boardState(longExpected));

    releaseLongRequest.resolve();
    await second.reload();
    await waitManagedReady(second);
    const offlineRestored=await managedState(second);
    assert.equal(offlineRestored.session.token,longer.session.token);
    assert.deepEqual(offlineRestored.actions,longer.actions,'API-offline reload must restore the complete compatible tail');
    assert.deepEqual(boardState(offlineRestored),boardState(longExpected));
    await assertRendered(second,longExpected);

    apiOffline=false;
    await second.unroute('**/api/scores**',offlineScores);
    await second.evaluate(() => window.dispatchEvent(new Event('online')));
    const saved=await waitSaved(second,offlineRestored);
    assert.deepEqual(saved.actions,longer.actions);
    assert.deepEqual(boardState(saved.state),boardState(longExpected));
    console.log('Browser: a late short ACK cannot erase another tab\'s compatible local tail; API-offline reload and later server save preserve it.');
  } finally {
    releaseShortAck.resolve();
    releaseLongRequest.resolve();
    await context.close();
  }
}
async function milestoneRegression(browser,page,base,errors) {
  const initial=await readState(page);
  assert.equal(initial.session.version,3);
  assert.equal(initial.actions.length,0);
  assert.equal(initial.bonuses.undo,2);
  assert.equal('pendingBonuses' in initial,false);
  const {env,steps}=first128Plan(initial.session.seed);
  for (let index=0;index<steps.length;index++) {
    await playFixtureAction(page,steps[index].action);
    const actual=await readState(page);
    assert.equal(actual.actions.length,index+1);
    assert.deepEqual(boardState(actual),boardState(steps[index].state));
  }
  const earned=await assertFixtureState(page,fixtureState(env));
  assert.equal(earned.bonuses.undo,2);
  assert.equal('pendingBonuses' in earned,false);
  const undoCounter=page.locator('[data-bonus=undo] .bonus-count');
  assert.notEqual(await undoCounter.getAttribute('data-pending'),'1');
  assert.equal(await undoCounter.evaluate(el => getComputedStyle(el,'::after').content),'none');
  if (process.env.TEST_UI_SCREENSHOT_DIR) {
    const viewport=page.viewportSize();
    await page.setViewportSize({width:390,height:640});
    await page.screenshot({path:process.env.TEST_UI_SCREENSHOT_DIR+'/earned-undo.png'});
    await page.setViewportSize(viewport);
  }
  await waitSaved(page,earned);
  await page.reload();
  await waitReady(page);
  assert.deepEqual(boardState(await readState(page)),boardState(fixtureState(env)));

  // A full ready counter has no stored reward, including on another profile.
  const rewardContext=await browser.newContext();
  const rewardPage=await login(rewardContext,base,errors);
  const remoteEarned=await readState(rewardPage);
  assert.deepEqual(boardState(remoteEarned),boardState(fixtureState(env)));
  assert.deepEqual(remoteEarned.actions,earned.actions);
  await assertRendered(rewardPage,fixtureState(env));

  await playFixtureAction(page,['undo']);
  let expected=fixtureAction(env,['undo']);
  let actual=await assertFixtureState(page,expected);
  assert.equal(actual.bonuses.undo,1,'Undo must spend one of the two ready charges');
  assert.equal('pendingBonuses' in actual,false);
  const redo=steps.at(-1).action;
  await playFixtureAction(page,redo);
  expected=fixtureAction(env,redo);
  actual=await assertFixtureState(page,expected);
  assert.equal(Boolean(actual.reached[128]),true);
  assert.equal(actual.bonuses.undo,2);
  assert.equal('pendingBonuses' in actual,false);
  for (let repeat=0;repeat<2;repeat++) {
    await playFixtureAction(page,['undo']);
    expected=fixtureAction(env,['undo']);
    actual=await assertFixtureState(page,expected);
    assert.equal(actual.bonuses.undo,1);
    await playFixtureAction(page,redo);
    expected=fixtureAction(env,redo);
    actual=await assertFixtureState(page,expected);
    assert.equal(actual.bonuses.undo,2,'Every new 128 merge must replenish the spent charge');
  }
  await waitSaved(page,actual);
  await page.reload();
  await waitReady(page);
  assert.deepEqual(boardState(await readState(page)),boardState(expected));
  await rewardPage.reload();
  await waitReady(rewardPage);
  const remoteSpent=await readState(rewardPage);
  assert.deepEqual(boardState(remoteSpent),boardState(expected));
  assert.deepEqual(remoteSpent.actions,actual.actions);
  await assertRendered(rewardPage,expected);
  await rewardContext.close();
  console.log('Browser: full-cap 128 stores no reward; each Undo/128 redo replenishes the ready counter, including after save/reload.');
}
async function legacyFixtureRegression(browser,base,errors,fixture) {
  const username=fixture.username || 'smoke-legacy';
  const oldVersion=fixture.localState.session.version;
  const ancestor=username==='smoke-legacy-ancestor';
  assert([1,2].includes(oldVersion));
  assert.equal(fixture.localState.bonuses.undo,0);
  assert.equal(fixture.expectedState.bonuses.undo,ancestor ? 1 : 0);
  assert.equal('pendingBonuses' in fixture.expectedState,false);
  const context=await browser.newContext();
  const promotionParents=[];
  context.on('request',request => {
    if (request.method()==='PUT' && request.url().includes('/api/games')) {
      const body=request.postDataJSON();
      if (body && body.upgradeFrom) promotionParents.push(body.upgradeFrom);
    }
  });
  await context.addInitScript(({localState,username}) => {
    let installed=false;
    function installFixtureAndWrappers() {
      if (installed) return;
      const root=document.querySelector('#tfe');
      if (!root || root.dataset.user!==username || typeof window.GameManager!=='function' ||
          typeof window.ServerStorageManager!=='function' ||
          typeof window.ServerStorageManager.prototype.prepareGame!=='function') return;
      installed=true;
      const identity=encodeURIComponent(root.dataset.scoresUrl)+'.'+encodeURIComponent(root.dataset.user);
      const key='twentyfortyeight.gameState.'+identity;
      const marker=key+'.legacy-test-injected';
      if (!localStorage.getItem(marker)) {
        localStorage.setItem(key,JSON.stringify(localState));
        localStorage.setItem(marker,'1');
      }
      // Capture the actual instance and the state it reads before initial setup.
      // These wrappers leave construction and preparation behavior unchanged.
      const Original=window.GameManager;
      window.GameManager=function(...args) {
        const game=new Original(...args);
        window.__tfeTestGame=game;
        return game;
      };
      window.GameManager.prototype=Original.prototype;
      const prepare=window.ServerStorageManager.prototype.prepareGame;
      window.ServerStorageManager.prototype.prepareGame=function(previousState) {
        window.__tfeTestPrepared={version:previousState && previousState.session && previousState.session.version,
          actions:previousState && previousState.actions && previousState.actions.length};
        return prepare.apply(this,arguments);
      };
    }
    const requestFrame=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=callback => requestFrame(time => {
      // Preserve frame timing, but install the old state before application's
      // callback constructs GameManager. DOMContentLoaded can occur later.
      installFixtureAndWrappers();
      callback.call(window,time);
    });
    document.addEventListener('DOMContentLoaded',installFixtureAndWrappers,{once:true});
  },{localState:fixture.localState,username});
  const page=await login(context,base,errors,username);
  assert.deepEqual(await page.evaluate(() => window.__tfeTestPrepared),{
    version:oldVersion,actions:fixture.localState.actions.length,
  },'Startup must read the complete offline history under its original rules');
  assert.equal(await page.evaluate(() => window.__tfeTestGame.rulesVersion),3);
  const promoted=await readState(page);
  assert.equal(promoted.session.version,3);
  assert(promoted.session.token!==fixture.localState.session.token,'Migration must issue a version-3 session');
  assert.equal(promoted.session.seed,fixture.localState.session.seed);
  assert.deepEqual(promoted.actions,fixture.localState.actions,'Every offline action must survive migration');
  assert.deepEqual(boardState(promoted),boardState(fixture.expectedState));
  assert.equal(promoted.bonuses.undo,fixture.expectedState.bonuses.undo,'Migration must preserve the canonical parent rules counter');
  if (ancestor) {
    assert(promoted.session.ancestorToken===fixture.localState.session.token,'The version-1 ancestor must remain linked');
    assert(promoted.session.previousToken!==fixture.localState.session.token,'The direct parent is the canonical version-2 session');
    assert(promotionParents.length>0);
    assert(promotionParents.every(token => token===promoted.session.previousToken),'Offline promotion must use the direct version-2 parent');
  }
  await assertRendered(page,fixture.expectedState);
  const saved=await waitSaved(page,promoted);
  assert(saved.revision>fixture.localState.revision);
  assert.deepEqual(saved.actions,fixture.localState.actions);
  assert.deepEqual(boardState(saved.state),boardState(fixture.expectedState));
  await page.reload();
  await waitReady(page);
  const reloaded=await readState(page);
  assert.equal(reloaded.session.version,3);
  assert.deepEqual(reloaded.actions,fixture.localState.actions,'The init fixture must not replace the upgraded state on reload');
  assert.deepEqual(boardState(reloaded),boardState(fixture.expectedState));
  await assertRendered(page,fixture.expectedState);
  const remoteContext=await browser.newContext();
  const remotePage=await login(remoteContext,base,errors,username);
  const remote=await readState(remotePage);
  assert.equal(remote.session.version,3);
  assert.deepEqual(remote.actions,fixture.localState.actions);
  assert.deepEqual(boardState(remote),boardState(fixture.expectedState));
  await assertRendered(remotePage,fixture.expectedState);

  // Future moves use rule 3 after the old bank-dependent history was preserved.
  const history={actions:copy(promoted.actions),peakScore:fixture.expectedState.peakScore,
    bestTileEver:fixture.expectedState.maxTile,movesAtPeakScore:0};
  const env=createGame(promoted.session.seed,copy(fixture.expectedState),history,3);
  const readyBeforeNewMerge=env.game.bonuses.undo;
  let merge;
  for (let move=0;move<1000 && env.game.bonuses.undo===readyBeforeNewMerge;move++) {
    assert.equal(env.game.over,false);
    const direction=chooseMove(env.game);
    assert.notEqual(direction,null);
    merge=['move',direction];
    await playFixtureAction(page,merge);
    await assertFixtureState(page,fixtureAction(env,merge));
  }
  assert.equal(env.game.bonuses.undo,readyBeforeNewMerge+1,'A new 128 must award a charge even when the old reached map records it');
  for (let repeat=0;repeat<2;repeat++) {
    await playFixtureAction(page,['undo']);
    let expected=fixtureAction(env,['undo']);
    assert.equal((await assertFixtureState(page,expected)).bonuses.undo,readyBeforeNewMerge);
    await playFixtureAction(page,merge);
    expected=fixtureAction(env,merge);
    assert.equal((await assertFixtureState(page,expected)).bonuses.undo,readyBeforeNewMerge+1,'Each repeated 128 merge must award another ready charge');
  }
  const final=await readState(page);
  await waitSaved(page,final);
  await remotePage.reload();
  await waitReady(remotePage);
  assert.deepEqual(boardState(await readState(remotePage)),boardState(fixtureState(env)));
  await assertRendered(remotePage,fixtureState(env));
  await remoteContext.close();
  await context.close();
  console.log('Browser: version-'+oldVersion+' offline tail preserves its ready counter at the rule-3 cutover; future 128 merges replenish on every repeat.');
}
async function legacyUpgradeRegression(browser,base,errors,file) {
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  for (const fixture of data.fixtures || [data]) await legacyFixtureRegression(browser,base,errors,fixture);
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

    await milestoneRegression(browser,page,base,errors);
    if (process.env.TEST_LEGACY_GAME_FILE) {
      await legacyUpgradeRegression(browser,base,errors,process.env.TEST_LEGACY_GAME_FILE);
    }

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
    await firstContext.close();
    await sharedDraftRegression(browser,base,errors);
    assert.deepEqual(errors, []);
    console.log('Browser milestone rewards, cross-device restore/conflicts, shared-tab draft recovery, score/reload/Undo, silent saving, mobile geometry/scrolling, keyboard bonuses and restart passed.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e.stack || e.message);process.exitCode=1;});

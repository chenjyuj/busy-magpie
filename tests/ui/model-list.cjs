// The provider-grouped card, checked in a real Electron window against a
// local mock gateway: one grey head per provider with its allowance bar, one
// white row per model, live requests keeping the last completed metrics, the
// row cap, the stale frame after a dropped gateway, the light theme and the
// panel's click blocking. Runs offscreen so it never disturbs the desktop.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'model-list');
const profile = path.join(output, 'profile-' + process.pid);
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ running: true }));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.disableHardwareAcceleration();
let win, visible = false, ignored = true, cursor = { x: -10000, y: -10000 };
let hitAreas = null;
const checks = [];
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { checks.push(name); console.log('PASS', name); };
const server = http.createServer((req, res) => {
  const data = req.url.includes('/usage')
    ? { period: '30d', calls: 3, input: 14120, output: 1650, cache_read: 520 }
    : { seq: 1, pid: 12345, totals: { requests: 3, rerouted: 0, errors: 0 }, routes: [] };
  setTimeout(() => {
    if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
  }, req.url.includes('wait=') ? 100 : 0);
});
app.on('browser-window-created', (_event, created) => {
  win = created;
  win.showInactive = () => { visible = true; win.emit('show'); };
  win.isVisible = () => visible;
  win.hide = () => { visible = false; win.emit('hide'); };
  win.focus = () => {};
  win.blur = () => win.emit('blur');
  const ignore = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (value, options) => { ignored = value; ignore(value, options); };
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
ipcMain.on('busy:hit-areas', (_event, data) => { hitAreas = data; });
ipcMain.on('busy:ready', () => setTimeout(run, 200));
async function js(code) { return win.webContents.executeJavaScript(code); }
const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

// A streamed, completed request: 240 output tokens over 2.4 s -> 100 tok/s.
const route = (id, served, extra = {}) => {
  const provider = extra.provider || 'officeace';
  const account = extra.account || `user${id}@example.com`;
  const seat = {
    id: `acct-${id}`, provider, name: extra.providerName || 'OfficeAce',
    kind: 'account', who: account, model: served,
    known: extra.known !== false,
    used: extra.used === undefined ? 11 : extra.used,
    amount: 5755, limit: 9600, unit: 'credits',
    renews: ['2026-11-19T16:00:00Z'], usedRenews: '2026-11-19T16:00:00Z',
    ...(extra.windowless ? { amount: undefined, limit: undefined, unit: undefined } : {}),
  };
  return {
    id, time: new Date(Date.now() - id * 5000).toISOString(), agent: 'dsh',
    model: `group/${served}`, provider, done: true, status: 200,
    ms: 3000, ttft: 600, out: 240, flow: 2400, reasoning: 0,
    tries: [{ id: `acct-${id}`, model: served, done: true, status: 200, ms: 3000, ttft: 600 }],
    order: [seat],
    ...extra,
  };
};

async function run() {
  try {
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => ['magpie:trace', 'magpie:connection'].includes(channel)
      ? undefined : send(channel, ...args);
    await js('(async()=>{const c=await window.busy.settingsGet();return window.busy.settingsSave({...c.settings,quietMotion:true});})()');

    const feed = async list => {
      send('magpie:trace', { pid: 12345, seq: 40, now: new Date().toISOString(), totals: { requests: list.length }, routes: list });
      send('magpie:connection', { online: true, detail: '127.0.0.1:3425' });
      await sleep(150);
    };
    const groups = () => js(`([...document.querySelectorAll('.provider-group')].map(group => ({
      provider: group.dataset.provider,
      title: group.querySelector('.provider-head b')?.textContent ?? null,
      remaining: group.querySelector('.provider-left')?.textContent ?? null,
      barClass: group.querySelector('.provider-bar i')?.className ?? null,
      barWidth: group.querySelector('.provider-bar i')?.style.width ?? null,
      hasBar: Boolean(group.querySelector('.provider-quota')),
      models: [...group.querySelectorAll('.model-row')].map(row => ({
        model: row.dataset.model,
        status: row.dataset.status,
        name: row.querySelector('.model-name')?.textContent ?? null,
        ms: row.querySelector('.col-ms')?.textContent ?? null,
        ttft: row.querySelector('.col-ttft')?.textContent ?? null,
        speed: row.querySelector('.col-speed')?.textContent ?? null,
        state: row.querySelector('.state-word')?.textContent ?? null,
        reroute: row.querySelector('.row-reroute')?.textContent ?? null,
      })),
    })))`);

    // 1. One group per provider, newest first, one row per model.
    await feed([
      route(1, 'glm-5.3', { provider: 'officeace', providerName: 'OfficeAce' }),
      route(2, 'claude-sonnet-4-5', { provider: 'officeace', providerName: 'OfficeAce' }),
      route(3, 'deepseek-v4.1-flash', { provider: 'workbuddy', providerName: 'WorkBuddy AI', used: 0 }),
    ]);
    const two = await groups();
    assert.equal(two.length, 2);
    assert.deepEqual(two.map(g => g.provider), ['officeace', 'workbuddy']);
    assert.equal(two[0].title, 'OfficeAce');
    assert.equal(two[0].remaining, '剩余 89%');
    assert.equal(two[1].title, 'WorkBuddy AI');
    assert.equal(two[1].remaining, '剩余 100%');
    assert.ok(two[0].hasBar && two[1].hasBar);
    assert.equal(two[0].models.length, 2);
    assert.equal(two[1].models.length, 1);
    for (const row of two[0].models) {
      assert.equal(row.ms, '3.0 秒');
      assert.equal(row.ttft, '600ms');
      assert.equal(row.speed, '100 tok/s');
      assert.equal(row.state, '完成');
    }
    fs.writeFileSync(path.join(output, 'groups.png'), (await win.webContents.capturePage()).toPNG());
    record('groups come one per provider with its allowance, one row per model');

    // 2. The allowance bar is tinted by what is left.
    await feed([
      route(1, 'ok-model', { provider: 'p-ok', used: 11 }),
      route(2, 'mid-model', { provider: 'p-mid', used: 60 }),
      route(3, 'low-model', { provider: 'p-low', used: 85 }),
    ]);
    const tints = Object.fromEntries((await groups()).map(g => [g.provider, g]));
    assert.equal(tints['p-ok'].barClass, '');
    assert.ok(tints['p-ok'].barWidth.startsWith('89'));
    assert.equal(tints['p-mid'].barClass, 'mid');
    assert.equal(tints['p-low'].barClass, 'low');
    record('the allowance bar is green, amber or red by what is left');

    // 3. A provider without a reported allowance shows no bar — neither when it
    //    reports nothing, nor when it reports "known, 0 used" but no window
    //    (a vendor whose quota could not be read must not read as 100% left).
    await feed([route(1, 'anon-model', { provider: 'p-anon', known: false })]);
    const anon = (await groups())[0];
    assert.equal(anon.hasBar, false);
    assert.equal(anon.remaining, null);
    await feed([route(1, 'blind-model', { provider: 'p-blind', known: true, used: 0, windowless: true })]);
    const blind = (await groups())[0];
    assert.equal(blind.hasBar, false, 'a windowless seat must not claim 100% left');
    assert.equal(blind.remaining, null);
    record('a provider with no reported allowance shows no bar at all');

    // 4. A live request keeps the last completed metrics and only flips the state.
    await feed([
      route(1, 'glm-5.3', { provider: 'officeace', providerName: 'OfficeAce' }),
      route(0, 'glm-5.3', { provider: 'officeace', providerName: 'OfficeAce', done: false, status: 0,
        ms: 0, ttft: 0, out: 0, tries: [{ id: 'acct-0', model: 'glm-5.3', done: false, status: 0 }] }),
    ]);
    const liveRow = (await groups())[0].models[0];
    assert.equal(liveRow.status, 'live');
    assert.equal(liveRow.state, '进行中');
    assert.equal(liveRow.ms, '3.0 秒');
    assert.equal(liveRow.ttft, '600ms');
    assert.equal(liveRow.speed, '100 tok/s');
    fs.writeFileSync(path.join(output, 'live.png'), (await win.webContents.capturePage()).toPNG());
    record('a live request keeps the last completed metrics instead of blanking them');

    // 5. A request that never completed has no metrics, and a missing metric is a dash.
    await feed([route(1, 'never-model', { provider: 'p-a', done: false, status: 0, ms: 0, ttft: 0, out: 0,
      tries: [{ id: 'acct-1', model: 'never-model', done: false, status: 0 }] })]);
    const never = (await groups())[0].models[0];
    assert.equal(never.ms, '—');
    assert.equal(never.ttft, '—');
    assert.equal(never.speed, '—');
    await feed([route(1, 'sparse', { provider: 'p-b', ms: 4200, ttft: 0, out: 0,
      tries: [{ id: 'acct-1', model: 'sparse', done: true, status: 200, ms: 4200 }] })]);
    const sparse = (await groups())[0].models[0];
    assert.equal(sparse.ms, '4.2 秒');
    assert.equal(sparse.ttft, '—');
    assert.equal(sparse.speed, '—');
    const body = await js('document.querySelector(".model-rows, .provider-groups").textContent');
    assert.doesNotMatch(body, /0ms|0 毫秒|0 tok\/s/);
    record('missing measurements read as a dash, and a never-finished request shows none');

    // 6. An error row outranks the others and says so.
    await feed([route(1, 'bad', { provider: 'p-err', status: 500, error: 'upstream rejected' })]);
    const errored = (await groups())[0].models[0];
    assert.equal(errored.status, 'error');
    assert.equal(errored.state, '错误');
    record('a failed request reads 错误');

    // 7. More models than the cap keeps the groups whole and counts the rest.
    const many = [];
    for (let index = 1; index <= 8; index += 1) {
      many.push(route(index, `m${index}`, { provider: `p${Math.ceil(index / 3)}`, providerName: `P${Math.ceil(index / 3)}` }));
    }
    await feed(many);
    const capped = await groups();
    const shown = capped.reduce((n, group) => n + group.models.length, 0);
    assert.ok(shown > 0 && shown <= 6, `rows stay within the cap: ${shown}`);
    assert.equal((await text('#modelHidden')), `+${8 - shown} 个模型`);
    assert.ok(capped.every(group => group.models.length > 0), 'no group head without a row');
    fs.writeFileSync(path.join(output, 'capped.png'), (await win.webContents.capturePage()).toPNG());
    record('the cap keeps model rows, never leaves a group head dangling');

    // 8. The light theme actually reaches the card and its rows.
    const theme = await js(`(()=>{const card=getComputedStyle(document.querySelector('.card'));
      const row=document.querySelector('.model-row');
      return { card: card.backgroundColor, radius: card.borderRadius,
        row: row ? getComputedStyle(row).backgroundColor : '' };})()`);
    assert.equal(theme.card, 'rgb(245, 245, 247)');
    assert.ok(theme.radius.startsWith('16px'));
    assert.equal(theme.row, 'rgb(255, 255, 255)');
    record('the card is the opaque light sheet with white rows');

    // 9. A dropped gateway keeps the last frame and labels it stale.
    send('magpie:connection', { online: false, detail: 'magpie 未启动，或当前端口没有网关监听', retry: true });
    await sleep(150);
    assert.ok((await groups()).length > 0);
    assert.equal(await js('document.body.classList.contains("stale")'), true);
    assert.equal(await js('document.getElementById("liveState").textContent'), '重连中');
    fs.writeFileSync(path.join(output, 'stale.png'), (await win.webContents.capturePage()).toPNG());
    record('a dropped gateway keeps the last frame and marks it stale');

    // 10. The panel still blocks the pointer and reports scaled hit areas.
    assert.equal(ignored, false);
    const pill = await js(`(()=>{const r=document.getElementById('tokenPill').getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};})()`);
    assert.ok(hitAreas.controls.some(box => box.x === pill.x && box.y === pill.y && box.width === pill.width),
      'the token pill stays clickable');
    assert.ok(hitAreas.dragBottom > hitAreas.dragTop, 'the drag strip is reported');
    record('the card keeps blocking clicks and reporting its hit areas');

    // 11. A bigger window rescales the card without overflowing it, and compact mode hides the list.
    win.setBounds({ x: 40, y: 40, width: 700, height: 700 });
    await feed([route(1, 'resize-a', { provider: 'p-r1' }), route(2, 'resize-b', { provider: 'p-r2' })]);
    await sleep(260);
    const fit = await js(`(()=>{const list=document.querySelector('.model-list').getBoundingClientRect();
      const rows=[...document.querySelectorAll('.model-row')];
      const last=rows.length?rows.pop().getBoundingClientRect():{bottom:0};
      return { windowH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-h')),
        bottom:last.bottom, limit:list.bottom };})()`);
    assert.ok(fit.windowH > 432, `the window grew (${fit.windowH})`);
    assert.ok(fit.bottom <= fit.limit + 0.5, `rows stay inside the list (${fit.bottom} <= ${fit.limit})`);
    await js('window.busy.toggleCompact()');
    await sleep(320);
    assert.equal(await js('document.body.classList.contains("compact")'), true);
    assert.equal(await js('getComputedStyle(document.querySelector(".stage-area")).display'), 'none');
    assert.equal(await js('getComputedStyle(document.getElementById("compactView")).display'), 'flex');
    record('a resized window keeps rows inside the card and compact mode hides the list');

    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, rendererErrors: errors }, null, 2));
    server.close(); win.destroy(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failed.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack, rendererErrors: errors }, null, 2));
    server.close(); win.destroy(); app.exit(1);
  }
}
server.listen(0, '127.0.0.1', async () => {
  const gateway = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ gateway, topmost: false, autostart: false, keepAlive: false, updateMode: 'never', usagePeriod: '30d', left: 40, top: 40 }));
  await app.whenReady();
  screen.getCursorScreenPoint = () => cursor;
  const filename = path.join(root, 'src/main.js');
  const mainModule = new Module(filename, module);
  mainModule.filename = filename;
  mainModule.paths = Module._nodeModulePaths(path.dirname(filename));
  mainModule.require = function (id) {
    if (id === '../shell/windows-blur.cjs') return { attachBlur: () => ({ refresh() {} }) };
    if (id === 'electron') return {
      ...require('electron'),
      BrowserWindow: class extends BrowserWindow {
        constructor(options) {
          const { backgroundMaterial, ...offscreenOptions } = options;
          super({ ...offscreenOptions, transparent: true, roundedCorners: false, hasShadow: false, webPreferences: { ...options.webPreferences, offscreen: true } });
        }
      },
    };
    return Module.prototype.require.call(this, id);
  };
  mainModule._compile(fs.readFileSync(filename, 'utf8'), filename);
});
setTimeout(() => { console.error('UI check timed out'); app.exit(2); }, 40000).unref();
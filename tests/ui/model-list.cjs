// The card's model list, checked in a real Electron window against a local
// mock gateway: one row per served model, its four measurements, the states,
// the six-row cap, the stale frame after a dropped gateway and the panel's
// click blocking. Runs offscreen so it never disturbs the desktop.
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
const text = selector => js(`document.querySelector(${JSON.stringify(selector)}).textContent`);
const rows = () => js(`([...document.querySelectorAll('.model-row')].map(node => ({
  model: node.dataset.model,
  status: node.dataset.status,
  name: node.querySelector('.model-name').textContent,
  state: node.querySelector('.state-word').textContent,
  ms: node.querySelector('.col-ms').textContent,
  ttft: node.querySelector('.col-ttft').textContent,
  speed: node.querySelector('.col-speed').textContent,
  reroute: node.querySelector('.row-reroute')?.textContent || '',
  tip: node.title,
})))`);

// A streamed reply at a measurable pace: 240 output tokens over 2.4s.
const route = (id, served, extra = {}) => ({
  id, time: new Date(Date.now() - id * 5000).toISOString(), agent: 'dsh',
  model: `group/${served}`, provider: 'officeace', done: true, status: 200,
  ms: 3000, ttft: 600, out: 240, flow: 2400, reasoning: 0,
  tries: [{ id: `acct-${id}`, model: served, done: true, status: 200, ms: 3000, ttft: 600 }],
  order: [{ id: `acct-${id}`, name: 'OfficeAce', provider: 'officeace', kind: 'account', who: `user${id}@example.com`, model: served }],
  ...extra,
});

async function run() {
  try {
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => ['magpie:trace', 'magpie:connection'].includes(channel)
      ? undefined : send(channel, ...args);
    await js('(async()=>{const c=await window.busy.settingsGet();return window.busy.settingsSave({...c.settings,quietMotion:true});})()');

    const feed = async list => {
      const payload = { pid: 12345, seq: 40, now: new Date().toISOString(), totals: { requests: list.length }, routes: list };
      send('magpie:trace', payload);
      send('magpie:connection', { online: true, detail: '127.0.0.1:3425' });
      await sleep(140);
    };

    // 1. One row per served model, newest first, four measurements each.
    await feed([route(1, 'glm-5.3'), route(2, 'claude-sonnet-4-5'), route(3, 'deepseek-v4.1-flash')]);
    const three = await rows();
    assert.equal(three.length, 3);
    assert.deepEqual(three.map(row => row.model), ['glm-5.3', 'claude-sonnet-4-5', 'deepseek-v4.1-flash']);
    for (const row of three) {
      assert.equal(row.ms, '3.0 秒');
      assert.equal(row.ttft, '600ms');
      assert.equal(row.speed, '100 tok/s');
      assert.equal(row.state, '完成');
      assert.equal(row.status, 'ok');
      assert.match(row.tip, /^Officeace · u•••@e•••\.com · 最近活动 \d+s 前$/);
    }
    assert.equal(await js('document.getElementById("modelHidden").hidden'), true);
    fs.writeFileSync(path.join(output, 'three-models.png'), (await win.webContents.capturePage()).toPNG());
    record('one row per served model reports duration, first byte, pace and status');

    // 2. A missing measurement is a dash, never zero. The attempt must carry
    // no first byte either, or the fallback would legitimately supply one.
    await feed([route(1, 'glm-5.3', { ttft: 0, out: 0, ms: 4200, flow: 0, reasoning: 0,
      tries: [{ id: 'acct-1', model: 'glm-5.3', done: true, status: 200, ms: 4200 }] })]);
    const sparse = (await rows())[0];
    assert.equal(sparse.ms, '4.2 秒');
    assert.equal(sparse.ttft, '—');
    assert.equal(sparse.speed, '—');
    const body = await js('document.querySelector(".model-rows").textContent');
    assert.doesNotMatch(body, /0ms|0 毫秒|0 tok\/s/);
    record('missing measurements read as a dash, not as zero');

    // 3. Failure and work in progress are named and coloured differently.
    await feed([
      route(1, 'glm-5.3', { status: 500, error: 'upstream rejected the request' }),
      route(2, 'claude-sonnet-4-5', { done: false, status: 0, ms: 0, ttft: 900, out: 0,
        tries: [{ id: 'acct-2', model: 'claude-sonnet-4-5', done: false, status: 0, ttft: 900 }] }),
    ]);
    const states = await rows();
    const byModel = Object.fromEntries(states.map(row => [row.model, row]));
    assert.equal(byModel['glm-5.3'].status, 'error');
    assert.equal(byModel['glm-5.3'].state, '错误');
    assert.equal(byModel['claude-sonnet-4-5'].status, 'live');
    assert.equal(byModel['claude-sonnet-4-5'].state, '进行中');
    assert.equal(byModel['claude-sonnet-4-5'].ms, '—');
    assert.equal(byModel['claude-sonnet-4-5'].ttft, '900ms');
    assert.equal(byModel['claude-sonnet-4-5'].speed, '—');
    record('a failed request reads 错误 and a running one reads 进行中');

    // 4. A rerouted request belongs to its last model and says how often it moved.
    await feed([route(1, 'deepseek-v4.1-flash', {
      tries: [
        { id: 'a', model: 'glm-5.3', done: true, status: 500, fail: true },
        { id: 'b', model: 'deepseek-v4.1-flash', done: true, status: 200 },
      ],
    })]);
    const rerouted = (await rows())[0];
    assert.equal(rerouted.model, 'deepseek-v4.1-flash');
    assert.equal(rerouted.reroute, '改道 1 次');
    assert.match(rerouted.tip, /改道 1 次/);
    record('a rerouted request shows how many models it moved through');

    // 5. More than six models keeps six rows and counts the rest.
    const many = Array.from({ length: 7 }, (_, index) => route(index + 1, `model-${index + 1}`));
    await feed(many);
    const capped = await rows();
    assert.equal(capped.length, 6);
    assert.equal((await text('#modelHidden')), '+1 个模型');
    assert.equal(await js('document.getElementById("modelHidden").hidden'), false);
    fs.writeFileSync(path.join(output, 'seven-models.png'), (await win.webContents.capturePage()).toPNG());
    record('seven models render six rows plus a +N summary');

    // 6. A dropped gateway keeps the last frame and labels it instead of blanking.
    send('magpie:connection', { online: false, detail: 'magpie 未启动，或当前端口没有网关监听', retry: true });
    await sleep(140);
    assert.equal((await rows()).length, 6);
    assert.equal(await js('document.body.classList.contains("stale")'), true);
    assert.equal(await js('document.getElementById("liveState").textContent'), '重连中');
    fs.writeFileSync(path.join(output, 'stale.png'), (await win.webContents.capturePage()).toPNG());
    record('a dropped gateway keeps the last frame and marks it stale');

    // 7. The panel still blocks the pointer and reports scaled hit areas.
    assert.equal(ignored, false);
    assert.ok(hitAreas, 'hit areas are reported');
    const pill = await js(`(()=>{const r=document.getElementById('tokenPill').getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};})()`);
    assert.ok(hitAreas.controls.some(box => box.x === pill.x && box.y === pill.y && box.width === pill.width),
      'the token pill stays clickable');
    assert.ok(hitAreas.dragBottom > hitAreas.dragTop, 'the drag strip is reported');
    assert.ok(hitAreas.ui > 0, 'the UI scale is reported');
    record('the card keeps blocking clicks and reporting its hit areas');

    // 8. A bigger window rescales the list without overflowing it, and compact
    // mode hides the list. Both go through the real main process: it owns the
    // frame, so a frame invented by this test would be overwritten by the real
    // one — the window is resized instead.
    win.setBounds({ x: 40, y: 40, width: 700, height: 700 });
    await feed([route(1, 'glm-5.3'), route(2, 'claude-sonnet-4-5'), route(3, 'deepseek-v4.1-flash'),
      route(4, 'model-4'), route(5, 'model-5'), route(6, 'model-6')]);
    await sleep(260);
    const fit = await js(`(()=>{const list=document.querySelector('.model-list').getBoundingClientRect();
      const nodes=[...document.querySelectorAll('.model-row')];
      const last=nodes.length?nodes.pop().getBoundingClientRect():{bottom:0};
      return { scale:Number(getComputedStyle(document.documentElement).getPropertyValue('--ui')),
        windowH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-h')),
        bottom:last.bottom, limit:list.bottom };})()`);
    assert.ok(fit.scale > 0, 'the list keeps a scale');
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
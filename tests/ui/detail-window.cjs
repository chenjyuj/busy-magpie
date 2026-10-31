// The request detail window, checked in a real Electron pair of windows: the
// card opens a second window for one (provider, model) and lists every request
// that pair served. Runs offscreen so it never disturbs the desktop.
//
// This harness owns the *first* window it sees as the card; anything created
// afterwards is the detail window and is left unstubbed.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'detail-window');
const profile = path.join(output, 'profile-' + process.pid);
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ running: true }));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.disableHardwareAcceleration();

let card = null;
let cardVisible = false;
let ignored = true;
let hitAreas = null;
let opened = null;
const checks = [];
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { checks.push(name); console.log('PASS', name); };
const detail = () => BrowserWindow.getAllWindows().find(window => window !== card) || null;
async function cardJs(code) { return card.webContents.executeJavaScript(code); }
async function detailJs(code) {
  const win = detail();
  return win ? win.webContents.executeJavaScript(code) : null;
}

// The gateway the app actually polls: whatever `feed()` last parked here is
// what main merges into the table it pushes on to both windows.
let servedRoutes = [];
let traceSeq = 0;
const server = http.createServer((req, res) => {
  if (req.url.includes('/usage')) {
    const usage = { period: '30d', calls: 3, input: 14120, output: 1650, cache_read: 520 };
    if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(usage)); }
    return;
  }
  traceSeq += 1;
  const body = { seq: traceSeq, pid: 12345, totals: { requests: servedRoutes.length, rerouted: 0, errors: 0 }, routes: servedRoutes };
  // A short pause stands in for magpie's long poll, so the app is not spinning.
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }, 120);
});

app.on('browser-window-created', (_event, created) => {
  created.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  if (card) return;                       // the detail window stays untouched
  card = created;
  card.showInactive = () => { cardVisible = true; card.emit('show'); };
  card.isVisible = () => cardVisible;
  card.hide = () => { cardVisible = false; card.emit('hide'); };
  card.focus = () => {};
  card.blur = () => card.emit('blur');
  const ignore = card.setIgnoreMouseEvents.bind(card);
  card.setIgnoreMouseEvents = (value, options) => { ignored = value; ignore(value, options); };
});
ipcMain.on('busy:hit-areas', (_event, data) => { hitAreas = data; });
ipcMain.on('detail:open', (_event, query) => { opened = query; });
ipcMain.on('busy:ready', () => setTimeout(run, 200));

// One request as magpie's trace would report it. `id` doubles as "how long ago"
// so the newest request is always id 1.
const request = (id, extra = {}) => ({
  id, time: new Date(Date.now() - id * 5000).toISOString(), agent: 'dsh',
  model: 'officeace/glm-5.3', served: 'glm-5.3', provider: 'officeace', done: true, status: 200,
  ms: 3000, ttft: 600, out: 240, flow: 2400, reasoning: 0,
  tries: [{ id: 'acct-1', model: 'glm-5.3', done: true, status: 200, ms: 3000, ttft: 600 }],
  order: [{
    id: 'acct-1', provider: 'officeace', name: 'OfficeAce', kind: 'account',
    who: 'alex@example.com', model: 'glm-5.3',
    known: true, used: 11, amount: 5755, limit: 9600, unit: 'credits',
    renews: ['2026-11-19T16:00:00Z'], usedRenews: '2026-11-19T16:00:00Z',
  }],
  ...extra,
});

async function run() {
  try {
    const push = card.webContents.send.bind(card.webContents);
    card.webContents.send = (channel, ...args) => ['magpie:trace', 'magpie:connection', 'magpie:usage', 'magpie:usage-status'].includes(channel)
      ? undefined : push(channel, ...args);
    const feed = async list => {
      servedRoutes = list;
      // The card is fed directly so its own assertions stay deterministic;
      // main's poll also carries the list to the detail window within a beat.
      push('magpie:trace', { pid: 12345, seq: 40, now: new Date().toISOString(), totals: { requests: list.length }, routes: list });
      push('magpie:connection', { online: true, detail: '127.0.0.1:3425' });
      await sleep(700);
    };

    // ── T4: the card offers a way in ────────────────────────────────────────
    await feed([request(1), request(2)]);
    const row = await cardJs(`(()=>{const r=document.querySelector('.model-row');
      return r ? { tabIndex: r.tabIndex, role: r.getAttribute('role'), label: r.getAttribute('aria-label') } : null;})()`);
    assert.ok(row, 'the card renders a model row');
    assert.equal(row.tabIndex, 0, 'the row is reachable by keyboard');
    assert.equal(row.role, 'button', 'the row announces itself as a button');
    assert.match(row.label || '', /glm-5\.3/, 'the row names the model it opens');
    record('a model row is a focusable button that names its model');

    await cardJs('document.querySelector(".model-row").click()');
    await sleep(300);
    assert.deepEqual(opened, { providerKey: 'officeace', model: 'glm-5.3', providerName: 'OfficeAce' });
    record('clicking a row asks for that provider and model');

    assert.ok(hitAreas && Array.isArray(hitAreas.controls), 'the card reports its hit areas');
    const rowBox = await cardJs(`(()=>{const r=document.querySelector('.model-row').getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};})()`);
    assert.ok(hitAreas.controls.some(box => box.x === rowBox.x && box.y === rowBox.y && box.width === rowBox.width),
      'the row is reported as a control so the window can take focus for it');
    record('the row is reported as a control, so keyboard focus can reach it');

    // ── T5: the window and its page ─────────────────────────────────────────
    await sleep(700);
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'the detail window opens beside the card');
    assert.ok(detail(), 'the second window is the detail window');
    assert.equal(await detailJs('document.getElementById("detailTitle").textContent'), 'OfficeAce · glm-5.3');
    record('the detail window opens with a title naming provider and model');

    const painted = await detailJs(`(()=>{const rows=[...document.querySelectorAll('.detail-row')];
      return { count: rows.length, card: getComputedStyle(document.querySelector('.detail-card')).backgroundColor,
        row: getComputedStyle(rows[0]).backgroundColor };})()`);
    assert.equal(painted.count, 2, 'both requests of that model are listed');
    assert.equal(painted.card, 'rgb(245, 245, 247)');
    assert.equal(painted.row, 'rgb(255, 255, 255)');
    record('one white row per request on the light sheet');

    const first = await detailJs(`(()=>{const r=document.querySelector('.detail-row');
      return { clock: r.querySelector('.col-clock').textContent, ms: r.querySelector('.col-ms').textContent,
        ttft: r.querySelector('.col-ttft').textContent, speed: r.querySelector('.col-speed').textContent,
        state: r.querySelector('.col-state').textContent };})()`);
    assert.match(first.clock, /^\d{2}:\d{2}:\d{2}$/, `a clock reading, got ${first.clock}`);
    assert.equal(first.ms, '3.0 秒');
    assert.equal(first.ttft, '600ms');
    assert.equal(first.speed, '100 tok/s');
    assert.equal(first.state, '完成');
    record('each row carries clock, duration, first byte, pace and state');
    fs.writeFileSync(path.join(output, 'detail.png'), (await detail().webContents.capturePage()).toPNG());

    await detailJs('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
    await sleep(500);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'Escape closes the detail window');
    record('Escape closes the detail window');

    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, rendererErrors: errors }, null, 2));
    server.close();
    BrowserWindow.getAllWindows().forEach(win => win.destroy());
    app.exit(0);
  } catch (error) {
    try { if (card && !card.isDestroyed()) fs.writeFileSync(path.join(output, 'failed.png'), (await card.webContents.capturePage()).toPNG()); } catch {}
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack, rendererErrors: errors }, null, 2));
    server.close();
    BrowserWindow.getAllWindows().forEach(win => win.destroy());
    app.exit(1);
  }
}

server.listen(0, '127.0.0.1', async () => {
  const gateway = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ gateway, topmost: false, autostart: false, keepAlive: false, updateMode: 'never', usagePeriod: '30d', left: 40, top: 40 }));
  await app.whenReady();
  screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
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
          const { backgroundMaterial, ...rest } = options;
          super({ ...rest, transparent: true, roundedCorners: false, hasShadow: false, webPreferences: { ...options.webPreferences, offscreen: true } });
        }
      },
    };
    return Module.prototype.require.call(this, id);
  };
  mainModule._compile(fs.readFileSync(filename, 'utf8'), filename);
});
setTimeout(() => { console.error('detail window check timed out'); app.exit(2); }, 40000).unref();

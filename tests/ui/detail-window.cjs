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
let servedPid = 12345;
let traceSeq = 0;
const server = http.createServer((req, res) => {
  if (req.url.includes('/usage')) {
    const usage = { period: '30d', calls: 3, input: 14120, output: 1650, cache_read: 520 };
    if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(usage)); }
    return;
  }
  traceSeq += 1;
  const body = { seq: traceSeq, pid: servedPid, totals: { requests: servedRoutes.length, rerouted: 0, errors: 0 }, routes: servedRoutes };
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
    const feed = async (list, options = {}) => {
      servedRoutes = list;
      if (options.pid) servedPid = options.pid;
      // The card is fed directly so its own assertions stay deterministic;
      // main's poll also carries the list to the detail window within a beat.
      push('magpie:trace', { pid: servedPid, seq: 40, now: new Date().toISOString(), totals: { requests: list.length }, routes: list });
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

    // ── T6: paging, live updates, following and closing ─────────────────────
    const clickRow = async model => {
      const hit = await cardJs(`(()=>{const rows=[...document.querySelectorAll('.model-row')];
        const row=rows.find(item=>item.dataset.model===${JSON.stringify(model)});
        if(!row) return false; row.click(); return true;})()`);
      assert.ok(hit, `the card lists a row for ${model}`);
      await sleep(700);
    };
    const rowCount = () => detailJs('document.querySelectorAll(".detail-row").length');
    const moreHidden = () => detailJs('document.getElementById("detailMore").hidden');

    const many = [];
    for (let id = 25; id >= 1; id -= 1) many.push(request(id));
    await feed(many);
    await clickRow('glm-5.3');
    assert.equal(await rowCount(), 20, 'the first page holds twenty rows');
    assert.equal(await moreHidden(), false, 'more is offered while older requests remain');
    await detailJs('document.getElementById("detailMore").click()');
    await sleep(300);
    assert.equal(await rowCount(), 25, 'the next page adds twenty more');
    assert.equal(await moreHidden(), true, 'the button goes away once the list is complete');
    record('twenty rows a page, with the rest on demand');

    // More requests than the loaded window: the window holds, the newest lands on top.
    const lots = [];
    for (let id = 45; id >= 1; id -= 1) lots.push(request(id));
    await feed(lots);
    await sleep(700);
    const windowed = await detailJs(`(()=>{const rows=[...document.querySelectorAll('.detail-row')];
      return { count: rows.length, first: rows[0].dataset.id, more: document.getElementById('detailMore').hidden,
        last: rows[rows.length - 1].dataset.id };})()`);
    assert.equal(windowed.count, 40, 'two loaded pages stay two loaded pages');
    assert.equal(windowed.first, '1', 'the newest request is on top');
    assert.equal(windowed.more, false, 'and the ones that fell outside are offered again');
    record('a newer request slides in on top without resizing the loaded window');

    // A request still in flight shows its own gaps, never the last completed numbers.
    await feed([request(0, { done: false, status: 0, ms: 0, ttft: 0, out: 0, tries: [{ id: 'acct-1', model: 'glm-5.3', done: false, status: 0 }] }), ...lots]);
    await sleep(700);
    const inflight = await detailJs(`(()=>{const r=document.querySelector('.detail-row');
      return { id: r.dataset.id, status: r.dataset.status, ms: r.querySelector('.col-ms').textContent,
        ttft: r.querySelector('.col-ttft').textContent, speed: r.querySelector('.col-speed').textContent,
        state: r.querySelector('.col-state').textContent };})()`);
    assert.equal(inflight.id, '0');
    assert.equal(inflight.status, 'live');
    assert.equal(inflight.ms, '—', 'an in-flight request reports no duration of its own');
    assert.equal(inflight.ttft, '—');
    assert.equal(inflight.speed, '—');
    assert.equal(inflight.state, '进行中');
    record('an in-flight row shows its own gaps instead of the last completed numbers');

    // The window rides along when the card moves.
    const work = screen.getDisplayMatching(card.getBounds()).workArea;
    card.setBounds({ x: work.x + 40, y: work.y + 60, width: card.getBounds().width, height: card.getBounds().height });
    await sleep(400);
    const anchored = { card: card.getBounds(), detail: detail().getBounds() };
    card.setBounds({ x: work.x + 20, y: work.y + 90, width: anchored.card.width, height: anchored.card.height });
    await sleep(400);
    const moved = { card: card.getBounds(), detail: detail().getBounds() };
    assert.equal(moved.card.x - anchored.card.x, -20, 'the card went where it was told');
    assert.ok(Math.abs((moved.detail.x - anchored.detail.x) - (moved.card.x - anchored.card.x)) <= 2,
      `the detail window follows in x (${anchored.detail.x} -> ${moved.detail.x})`);
    assert.ok(Math.abs((moved.detail.y - anchored.detail.y) - (moved.card.y - anchored.card.y)) <= 2,
      `the detail window follows in y (${anchored.detail.y} -> ${moved.detail.y})`);
    if (moved.card.x + moved.card.width + 12 + moved.detail.width <= work.x + work.width) {
      assert.equal(moved.detail.x, moved.card.x + moved.card.width + 12, 'it sits beside the card when there is room');
    }
    record('the detail window follows the card and sits beside it');

    // A restarted magpie empties the merged table, so the list empties too
    // instead of stranding rows for requests the gateway no longer knows.
    await feed([], { pid: 99999 });
    await sleep(700);
    assert.equal(await rowCount(), 0, 'no rows survive a gateway restart');
    assert.equal(await detailJs('document.getElementById("detailEmpty").hidden'), false, 'the empty note appears');
    assert.equal(await moreHidden(), true);
    record('a restarted gateway leaves an empty list, not stale rows');

    // Closing: the button, then the card hiding.
    await feed(many);
    await clickRow('glm-5.3');
    await detailJs('document.getElementById("detailClose").click()');
    await sleep(400);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'the close button closes the window');
    await clickRow('glm-5.3');
    card.hide();
    await sleep(500);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'hiding the card closes the detail window');
    record('the close button and a hidden card both close the detail window');

    // Another model reuses the same window and starts at its own first page.
    await feed([...many, request(30, {
      served: 'deepseek-v4.1-flash', model: 'officeace/deepseek-v4.1-flash', provider: 'officeace',
      tries: [{ id: 'acct-1', model: 'deepseek-v4.1-flash', done: true, status: 200, ms: 2500, ttft: 500 }],
      order: [{ id: 'acct-1', provider: 'officeace', name: 'OfficeAce', kind: 'account', who: 'alex@example.com',
        model: 'deepseek-v4.1-flash', known: true, used: 11, amount: 5755, limit: 9600, unit: 'credits',
        renews: ['2026-11-19T16:00:00Z'], usedRenews: '2026-11-19T16:00:00Z' }],
    })]);
    await clickRow('glm-5.3');
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    await clickRow('deepseek-v4.1-flash');
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'switching models reuses the window');
    assert.equal(await detailJs('document.getElementById("detailTitle").textContent'), 'OfficeAce · deepseek-v4.1-flash');
    assert.equal(await rowCount(), 1, 'the new model starts at its own first page');
    record('clicking another model swaps the list in the same window');

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

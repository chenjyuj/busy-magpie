// The 字号 (font tier) and 卡片大小 (card size) settings, checked in a real
// Electron window against a local mock gateway: a tier zooms the card on its
// own canvas and leaves the window where it is, the settings panel keeps
// reading at a fixed size whatever the tier, and a size preset resizes the
// window while keeping the card's shape. Runs offscreen.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'font-tiers');
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
    : { seq: 1, pid: 12345, totals: { requests: 2, rerouted: 0, errors: 0 }, routes: [] };
  setTimeout(() => {
    if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
  }, 0);
});
app.on('browser-window-created', (_event, created) => {
  // Only the first window is the card; a later window must keep its behaviour.
  if (win) return;
  win = created;
  win.showInactive = () => { visible = true; win.emit('show'); };
  win.isVisible = () => visible;
  win.hide = () => { visible = false; win.emit('hide'); };
  win.focus = () => {};
  win.blur = () => win.emit('blur');
  const ignore = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (value, options) => { ignored = value; ignore(value, options); };
  win.webContents.on('did-fail-load', (_event, code, description) => errors.push(`${code} ${description}`));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
ipcMain.on('busy:hit-areas', (_event, data) => { hitAreas = data; });
ipcMain.on('busy:ready', () => setTimeout(run, 250));
async function js(code) { return win.webContents.executeJavaScript(code); }

const route = (id, served, provider) => ({
  id, time: new Date(Date.now() - id * 5000).toISOString(), agent: 'dsh',
  model: `group/${served}`, provider, done: true, status: 200,
  ms: 3000, ttft: 600, out: 240, flow: 2400, reasoning: 0,
  tries: [{ id: `acct-${id}`, model: served, done: true, status: 200, ms: 3000, ttft: 600 }],
  order: [{
    id: `acct-${id}`, provider, name: provider === 'p-a' ? 'Alpha AI' : 'Beta AI',
    kind: 'account', who: `user${id}@example.com`, model: served, known: true,
    used: 11, amount: 5755, limit: 9600, unit: 'credits',
  }],
});

async function feed(send) {
  send('magpie:trace', {
    pid: 12345, seq: 40, now: new Date().toISOString(),
    totals: { requests: 2 }, routes: [route(1, 'model-a', 'p-a'), route(2, 'model-b', 'p-b')],
  });
  send('magpie:connection', { online: true, detail: '127.0.0.1:3425' });
  await sleep(220);
}

// Everything the checks need, read off the real laid-out card: the canvas the
// font tier shrinks, the scale it produces, and the size the model name reads
// at on screen (canvas px times scale).
const read = () => js(`(()=>{
  const root = getComputedStyle(document.documentElement);
  const ui = parseFloat(root.getPropertyValue('--ui')) || 1;
  const canvas = document.getElementById('stageCanvas');
  const name = document.querySelector('.model-name');
  const box = canvas.getBoundingClientRect();
  const list = document.querySelector('.model-list').getBoundingClientRect();
  const rows = [...document.querySelectorAll('.model-row')];
  const last = rows.length ? rows.pop().getBoundingClientRect() : { bottom: 0 };
  return {
    zoom: parseFloat(root.getPropertyValue('--font-zoom')) || 1,
    ui,
    canvasW: parseFloat(root.getPropertyValue('--canvas-w')),
    canvasH: parseFloat(root.getPropertyValue('--canvas-h')),
    canvasBox: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    nameSize: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
    nameOnScreen: name ? parseFloat(getComputedStyle(name).fontSize) * ui : 0,
    rowBottom: last.bottom,
    listBottom: list.bottom,
  };
})()`);

// The docs screenshots are taken at 2x so GitHub renders them crisply.
// capturePage only renders at the window's own scale, so ask CDP to double the
// device scale factor for one frame instead.
async function capture2x(file) {
  const debugger_ = win.webContents.debugger;
  if (!debugger_.isAttached()) debugger_.attach('1.3');
  try {
    const { width, height } = win.getContentBounds();
    await debugger_.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: false,
    });
    const shot = await debugger_.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  } finally {
    await debugger_.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
    debugger_.detach();
  }
}

async function saveSettings(patch) {
  return js(`(async()=>{
    const current = await window.busy.settingsGet();
    return window.busy.settingsSave({...current.settings, ...${JSON.stringify(patch)}});
  })()`);
}

async function run() {
  try {
    const send = win.webContents.send.bind(win.webContents);
    // The card polls the mock gateway on its own; mute those pushes so the
    // frames this test feeds are the ones the renderer lays out.
    win.webContents.send = (channel, ...args) => ['magpie:trace', 'magpie:connection'].includes(channel)
      ? undefined : send(channel, ...args);
    await js('(async()=>{const c=await window.busy.settingsGet();return window.busy.settingsSave({...c.settings,quietMotion:true});})()');
    await feed(send);
    assert.ok(await js('document.querySelectorAll(".model-row").length >= 1'), 'rows render first');
    const before = await read();
    const bounds = win.getBounds();
    record('the card renders at the default tier');

    // 1. A larger tier shrinks the canvas (a bigger --ui is the zoom), so the
    //    name reads bigger on screen, and the window does not move or resize.
    const large = await saveSettings({ fontSize: 'large' });
    assert.equal(large.ok, true);
    await sleep(280);
    const bigger = await read();
    assert.ok(Math.abs(bigger.zoom - 1.16) < 0.001, `large tier zoom (${bigger.zoom})`);
    assert.ok(bigger.canvasW < before.canvasW - 40, `the canvas narrowed (${before.canvasW} -> ${bigger.canvasW})`);
    assert.ok(bigger.ui > before.ui + 0.05, `the canvas scale grew (${before.ui} -> ${bigger.ui})`);
    assert.ok(bigger.nameOnScreen > before.nameOnScreen + 1.5,
      `the name reads bigger (${before.nameOnScreen.toFixed(1)} -> ${bigger.nameOnScreen.toFixed(1)}px)`);
    assert.deepEqual(win.getBounds(), bounds, 'the window keeps its bounds when only the type grew');
    assert.ok(bigger.rowBottom <= bigger.listBottom + 0.5, 'rows stay inside the list');
    const pill = await js(`(()=>{const r=document.getElementById('tokenPill').getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};})()`);
    assert.ok(hitAreas?.controls.some(box => box.x === pill.x && box.y === pill.y && box.width === pill.width),
      'the pill hit area follows the zoomed canvas');
    fs.writeFileSync(path.join(output, 'large.png'), (await win.webContents.capturePage()).toPNG());
    record('a larger tier zooms the card without touching the window');

    // 2. A smaller tier reads smaller than the default, still inside the card.
    const small = await saveSettings({ fontSize: 'small' });
    assert.equal(small.ok, true);
    await sleep(280);
    const smaller = await read();
    assert.ok(Math.abs(smaller.zoom - 0.88) < 0.001, `small tier zoom (${smaller.zoom})`);
    assert.ok(smaller.nameOnScreen < before.nameOnScreen - 1,
      `the name reads smaller (${before.nameOnScreen.toFixed(1)} -> ${smaller.nameOnScreen.toFixed(1)}px)`);
    assert.deepEqual(win.getBounds(), bounds, 'the window keeps its bounds when only the type shrank');
    fs.writeFileSync(path.join(output, 'card-small.png'), (await win.webContents.capturePage()).toPNG());
    record('a smaller tier zooms the card down without touching the window');

    // 3. The settings panel is chrome: it reads at the same on-screen size under
    //    every tier, and its form still fits the pane without scrolling.
    const panel = async () => js(`(()=>{
      const root = getComputedStyle(document.documentElement);
      const pane = document.getElementById('settingsPane');
      const inner = pane.querySelector('.settings-inner');
      const page = document.getElementById('settingsPage-appearance');
      const groups = pane.querySelector('.settings-groups');
      const lastChip = page.querySelector('.settings-group:last-of-type .settings-chip');
      const reset = document.getElementById('settingsResetPosition');
      const freeze = parseFloat(root.getPropertyValue('--ui')) || 1;
      const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) }; };
      return {
        hidden: pane.hidden,
        pane: box(pane), inner: box(inner), groups: box(groups),
        reset: box(reset),
        innerOverflow: inner.scrollHeight - inner.clientHeight,
        groupsOverflow: page.scrollHeight - groups.clientHeight,
        lastChipBottom: Math.round(lastChip.getBoundingClientRect().bottom),
        scale: parseFloat(getComputedStyle(inner).transform.split('(')[1]) || 1,
        ui: freeze,
      };
    })()`);
    await saveSettings({ fontSize: 'normal' });
    await sleep(220);
    send('magpie:settings-panel', { open: true, mode: 'settings' });
    await sleep(320);
    const normalPanel = await panel();
    assert.equal(normalPanel.hidden, false);
    assert.ok(normalPanel.lastChipBottom <= normalPanel.groups.bottom + 1,
      `the appearance form fits its pane (${normalPanel.lastChipBottom} <= ${normalPanel.groups.bottom})`);
    assert.ok(normalPanel.groupsOverflow <= 1,
      `the appearance page needs no scrolling (${normalPanel.groupsOverflow}px)`);
    // 复位 moved out of the form and into the panel head, so the 卡片大小 slot
    // could take the row it used to hold.
    assert.ok(normalPanel.reset.width > 0 && normalPanel.reset.height > 0,
      'the reset button sits in the settings head');
    assert.ok(normalPanel.reset.bottom < normalPanel.groups.y,
      `the reset button stays in the head (${normalPanel.reset.bottom} < ${normalPanel.groups.y})`);
    fs.writeFileSync(path.join(output, 'panel-normal.png'), (await win.webContents.capturePage()).toPNG());
    await capture2x(path.join(output, 'panel-normal@2x.png'));
    await saveSettings({ fontSize: 'xlarge' });
    await sleep(320);
    const bigPanel = await panel();
    assert.ok(Math.abs(bigPanel.pane.width - normalPanel.pane.width) <= 1,
      `the panel is the same width at every tier (${normalPanel.pane.width} -> ${bigPanel.pane.width})`);
    assert.ok(Math.abs(bigPanel.inner.width - normalPanel.inner.width) <= 1,
      `its inner sheet maps back onto the same on-screen width (${normalPanel.inner.width} -> ${bigPanel.inner.width})`);
    assert.ok(Math.abs(bigPanel.scale - 1 / 1.34) < 0.01, `the inner sheet undo-scales (${bigPanel.scale})`);
    assert.ok(bigPanel.lastChipBottom <= bigPanel.groups.bottom + 1,
      `the form still fits at the biggest tier (${bigPanel.lastChipBottom} <= ${bigPanel.groups.bottom})`);
    assert.ok(bigPanel.groupsOverflow <= 1, `the page still needs no scrolling at the biggest tier (${bigPanel.groupsOverflow}px)`);
    fs.writeFileSync(path.join(output, 'panel-xlarge.png'), (await win.webContents.capturePage()).toPNG());
    record('the settings panel reads at one size whatever the card tier');

    send('magpie:settings-panel', { open: false });
    await sleep(320);
    await saveSettings({ fontSize: 'normal' });
    await sleep(220);

    // 4. A size preset resizes the window, and the shape follows the canvas so
    //    the card never shows a band above or below.
    const resized = await saveSettings({ width: 460 });
    assert.equal(resized.ok, true);
    await sleep(320);
    const card = win.getBounds();
    assert.equal(card.width, 460, `the preset resized the window (${card.width})`);
    assert.ok(Math.abs(card.height - 317) <= 1, `the height follows the width (${card.height})`);
    const grown = await read();
    assert.ok(grown.canvasBox.width > before.canvasBox.width + 60, 'the card canvas widened with the window');
    assert.ok(grown.rowBottom <= grown.listBottom + 0.5, 'rows stay inside the list at the bigger size');
    const ratio = (card.width - 32) / (card.height - 32);
    assert.ok(Math.abs(ratio - 1.5) < 0.02, `the card keeps its shape (${ratio.toFixed(3)})`);
    fs.writeFileSync(path.join(output, 'card-xlarge.png'), (await win.webContents.capturePage()).toPNG());
    record('a card size preset resizes the window and keeps the card shape');

    // 4b. The smallest chip promises the smallest window main keeps at the
    //     card's shape — 308×216, where a 300-wide card would be snapped back
    //     by the height floor and the chip would be describing a window the
    //     user never gets.
    await saveSettings({ width: 308 });
    await sleep(320);
    const smallCard = win.getBounds();
    assert.equal(smallCard.width, 308, `the small preset is honoured (${smallCard.width})`);
    assert.equal(smallCard.height, 216, `the small preset keeps the card shape (${smallCard.height})`);
    record('the smallest size preset is the smallest window main keeps');

    // 5. Back to the standard size and tier: the card is where it started.
    const restored = await saveSettings({ width: 316, fontSize: 'normal' });
    assert.equal(restored.ok, true);
    await sleep(320);
    assert.deepEqual(win.getBounds(), bounds, 'the standard preset restores the original window');
    const after = await read();
    assert.ok(Math.abs(after.nameOnScreen - before.nameOnScreen) < 0.5,
      `the name reads as it did at the start (${before.nameOnScreen.toFixed(1)} -> ${after.nameOnScreen.toFixed(1)}px)`);
    record('the standard preset restores the original card');

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
setTimeout(() => { console.error('font tier check timed out'); app.exit(2); }, 60000).unref();

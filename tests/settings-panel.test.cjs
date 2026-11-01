const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('function setupSettingsPanel()');
const end = source.indexOf('\nlet aboutRefresh', start);
assert.ok(start >= 0 && end > start, 'load the actual renderer settings panel');
const setup = source.slice(start, end);
const flush = () => new Promise(setImmediate);

function panelHarness() {
  const elements = new Map();
  const loads = [];
  const saves = [];
  let onPanel;
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', textContent: '', hidden: true, style: {}, dataset: {}, handlers: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, getAttribute() {},
        addEventListener(name, handler) { this.handlers[name] = handler; },
      });
    }
    return elements.get(id);
  };
  // The save path reads the chip groups; give it one chip each so it can. A
  // chip remembers the pressed state the panel writes and replays a click the
  // way the browser would, so a test can press a tier the way a user does.
  const chip = (dataset) => ({
    dataset,
    pressed: true,
    handlers: {},
    getAttribute(name) { return name === 'aria-pressed' ? String(this.pressed) : null; },
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value === 'true'; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    click() { this.handlers.click?.(); },
  });
  const groups = {
    settingsUpdate: [chip({ update: 'idle' })],
    settingsPeriods: [chip({ period: 'today' })],
    settingsMetrics: [chip({ metric: 'total' })],
    settingsFontSizes: [
      chip({ font: 'small' }), chip({ font: 'normal' }),
      chip({ font: 'large' }), chip({ font: 'xlarge' }),
    ],
    settingsCardSizes: [
      chip({ card: 'small' }), chip({ card: 'normal' }),
      chip({ card: 'large' }), chip({ card: 'xlarge' }),
    ],
  };
  const querySelectorAll = (selector) => {
    for (const [name, chips] of Object.entries(groups)) {
      if (selector.includes(name)) return chips;
    }
    return [];
  };
  const context = {
    $: element, settings: {}, USAGE_PERIODS: ['today'], aboutRefresh: null,
    activePeriod: () => 'today', pressChips: () => {},
    connection: { online: true }, usageStatus: {}, usageData: null,
    document: {
      querySelectorAll,
      body: { classList: { add() {}, remove() {} } },
    },
    window: {
      clearTimeout() {}, setTimeout() {}, addEventListener() {},
      busy: {
        settingsGet: () => new Promise((resolve) => loads.push(resolve)),
        settingsSave: (payload) => { saves.push(payload); return Promise.resolve({ ok: true, version: 'test', settings: { ...payload }, path: '' }); },
        onSettingsPanel(handler) { onPanel = handler; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${setup}\nsetupSettingsPanel();`, context);
  return {
    element, saves, groups,
    open() { onPanel({ open: true, mode: 'settings' }); },
    close() { onPanel({ open: false }); },
    async resolveLoad(index, values = {}) {
      loads[index]({ settings: { ...values }, version: 'test', path: '' });
      await flush();
      assert.equal(element('settingsStatus').textContent, '');
    },
  };
}

test('a reply from an earlier opening cannot overwrite the current settings form', async () => {
  const h = panelHarness();
  h.open();
  h.close();
  h.open();
  await h.resolveLoad(1, { gateway: 'new-gateway' });
  await h.resolveLoad(0, { gateway: 'old-gateway' });
  assert.equal(h.element('settingsGateway').value, 'new-gateway');
});

test('saving the settings sends no opacity, which the opaque card no longer has', async () => {
  const h = panelHarness();
  h.open();
  await h.resolveLoad(0, { gateway: '127.0.0.1:3425', maskAccounts: true, topmost: true });
  h.element('settingsGateway').value = '127.0.0.1:3500';
  h.element('settingsForm').handlers.submit({ preventDefault() {} });
  await flush();
  await flush();
  assert.equal(h.saves.length, 1);
  assert.equal(Object.hasOwn(h.saves[0], 'opacity'), false);
  assert.equal(h.saves[0].gateway, '127.0.0.1:3500');
});

test('the font tier travels with the save and an untouched card chip sends no width', async () => {
  const h = panelHarness();
  h.open();
  await h.resolveLoad(0, { width: 316, fontSize: 'normal' });
  h.groups.settingsFontSizes[2].click();
  h.element('settingsForm').handlers.submit({ preventDefault() {} });
  await flush();
  await flush();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].fontSize, 'large');
  // The window was never re-tiered by hand, so the save leaves its width alone
  // instead of snapping a hand-dragged size to the nearest preset.
  assert.equal(Object.hasOwn(h.saves[0], 'width'), false);
});

test('pressing a card size chip sends that width and the chip then describes the window', async () => {
  const h = panelHarness();
  h.open();
  await h.resolveLoad(0, { width: 316, fontSize: 'normal' });
  h.groups.settingsCardSizes[3].click();
  h.element('settingsForm').handlers.submit({ preventDefault() {} });
  await flush();
  await flush();
  assert.equal(h.saves[0].width, 460);
  // The panel refills from the save reply, so the chip now describes the window
  // the save produced (the 460 it just sent), not the size the panel opened at.
  const tiers = h.groups.settingsCardSizes;
  assert.equal(tiers[3].pressed, true);
});

test('the panel shows the tier nearest the live window rather than a fixed one', async () => {
  const h = panelHarness();
  h.open();
  await h.resolveLoad(0, { width: 300, fontSize: 'xlarge' });
  assert.equal(h.groups.settingsCardSizes[0].pressed, true);
  assert.equal(h.groups.settingsFontSizes[3].pressed, true);
});

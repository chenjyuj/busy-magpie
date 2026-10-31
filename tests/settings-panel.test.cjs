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
  // The save path reads the chip groups; give it one chip each so it can.
  const chip = (dataset) => ({
    dataset,
    getAttribute: (name) => (name === 'aria-pressed' ? 'true' : null),
    setAttribute() {},
    addEventListener() {},
  });
  const querySelectorAll = (selector) => {
    if (selector.includes('settingsUpdate')) return [chip({ update: 'idle' })];
    if (selector.includes('settingsPeriods')) return [chip({ period: 'today' })];
    if (selector.includes('settingsMetrics')) return [chip({ metric: 'total' })];
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
        settingsSave: (payload) => { saves.push(payload); return Promise.resolve({ ok: true, version: 'test', settings: {}, path: '' }); },
        onSettingsPanel(handler) { onPanel = handler; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${setup}\nsetupSettingsPanel();`, context);
  return {
    element, saves,
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
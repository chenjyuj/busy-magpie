const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mainHarness} = require('./main-harness.cjs');

test('a failed write reports failure and leaves live settings unchanged', () => {
  const h=mainHarness({writeError:true});
  const before=JSON.stringify(h.api.settings());
  const result=h.save({...h.api.settings(),showTiming:false,topmost:false});
  assert.equal(result.ok,false);
  assert.match(result.error,/read-only/);
  assert.equal(JSON.stringify(h.api.settings()),before);
});

test('a successful save persists the same settings shown in the app', () => {
  const h=mainHarness();
  const result=h.save({...h.api.settings(),showTiming:false,topmost:false});
  assert.equal(result.ok,true);
  assert.equal(JSON.parse(h.files.get('/test/settings.json')).showTiming,false);
  assert.equal(h.api.settings().showTiming,false);
});

test('a legacy settings file that still carries opacity loads and stays usable', () => {
  const h=mainHarness();
  h.files.set('/test/settings.json',JSON.stringify({topmost:false,opacity:0.2,gateway:null}));
  const loaded=h.api.reloadSettings();
  assert.equal(loaded.maskAccounts,true);
  assert.equal(loaded.showTiming,true);
  // The card is opaque now, so nothing reads the stored value any more — but
  // an old profile must still start and save.
  const saved=h.save({...h.api.settings(),topmost:false});
  assert.equal(saved.ok,true);
});

test('an invalid gateway is rejected without changing the live address', () => {
  const h=mainHarness();const before=JSON.stringify(h.api.settings());
  const result=h.save({...h.api.settings(),gateway:'this is not an address'});
  assert.equal(result.ok,false);assert.equal(JSON.stringify(h.api.settings()),before);
});

test('the font tier survives a save and reload and falls back to normal', () => {
  const h=mainHarness();
  const saved=h.save({...h.api.settings(),fontSize:'xlarge'});
  assert.equal(saved.ok,true);
  assert.equal(JSON.parse(h.files.get('/test/settings.json')).fontSize,'xlarge');
  assert.equal(h.api.reloadSettings().fontSize,'xlarge');
  // An unknown value from a hand-edited profile must not doubt the zoom table.
  h.files.set('/test/settings.json',JSON.stringify({fontSize:'gigantic'}));
  assert.equal(h.api.reloadSettings().fontSize,'normal');
});

test('a card size preset arrives as a width and the height follows the card shape', () => {
  const h=mainHarness();
  const result=h.save({...h.api.settings(),width:460});
  assert.equal(result.ok,true);
  assert.equal(result.sizeChanged,true);
  assert.equal(result.settings.width,460);
  // heightForWidth: (width - 32) / 1.5 + 32, so the card keeps its shape and
  // never shows a band above or below the canvas.
  assert.equal(result.settings.height,317);
});
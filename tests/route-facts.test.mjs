// The facts a single route reports: shared by the card and the detail list so
// both read a request the same way. Pure functions, no window, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timestamp, numericId, newest, servedModel, measured, rerouteCount,
  statusOf, seatOf, quotaOf, providerKeyOf, clockOf,
} from '../web/route-facts.mjs';

test('providerKeyOf prefers the seat provider, falls back to the route and then to magpie', () => {
  assert.equal(providerKeyOf({ provider: 'RouteProvider', order: [{ provider: 'OfficeAce' }] }), 'officeace');
  assert.equal(providerKeyOf({ provider: 'WorkBuddy' }), 'workbuddy');
  assert.equal(providerKeyOf({ provider: '  ', order: [] }), 'magpie');
  assert.equal(providerKeyOf({}), 'magpie');
  assert.equal(providerKeyOf(undefined), 'magpie');
});

test('servedModel names the model that really answered', () => {
  assert.equal(servedModel({ served: 'glm-5.3', tries: [{ model: 'other' }] }), 'glm-5.3');
  assert.equal(servedModel({ tries: [{ model: 'alpha' }, { model: 'beta' }] }), 'beta');
  assert.equal(servedModel({ tries: [] }), '');
  assert.equal(servedModel(undefined), '');
});

test('statusOf ranks an error above a live request, and a finished one as ok', () => {
  assert.equal(statusOf({ status: 500, done: true }), 'error');
  assert.equal(statusOf({ error: '上游 500', done: true, status: 200 }), 'error');
  assert.equal(statusOf({ done: false, status: 0 }), 'live');
  assert.equal(statusOf({ done: true, status: 200 }), 'ok');
});

test('measured never turns zero or a non-number into a measurement', () => {
  assert.equal(measured(0), null);
  assert.equal(measured('0'), null);
  assert.equal(measured(undefined), null);
  assert.equal(measured(NaN), null);
  assert.equal(measured(600), 600);
});

test('rerouteCount counts the extra models a request moved through', () => {
  assert.equal(rerouteCount([{ model: 'a' }, { model: 'b' }, { model: 'b' }]), 1);
  assert.equal(rerouteCount([]), 0);
  assert.equal(rerouteCount(undefined), 0);
});

test('clockOf reads a local HH:MM:SS and gives nothing back for a broken time', () => {
  assert.equal(clockOf('2026-11-01T14:32:07+08:00'), '14:32:07');
  assert.equal(clockOf('abc'), '');
  assert.equal(clockOf(''), '');
  assert.equal(clockOf(undefined), '');
});

test('timestamp and numericId fall back to zero instead of NaN', () => {
  assert.equal(timestamp('2026-10-31T13:00:05.000Z'), Date.parse('2026-10-31T13:00:05.000Z'));
  assert.equal(timestamp('nonsense'), 0);
  assert.equal(numericId('7'), 7);
  assert.equal(numericId('nope'), 0);
});

test('newest puts the later request first and lets the id settle a tie', () => {
  const old = { time: '2026-10-31T13:00:01.000Z', id: 1 };
  const fresh = { time: '2026-10-31T13:00:09.000Z', id: 2 };
  assert.ok(newest(fresh, old) < 0);
  const tieLow = { time: '2026-10-31T13:00:05.000Z', id: 2 };
  const tieHigh = { time: '2026-10-31T13:00:05.000Z', id: 9 };
  assert.deepEqual([tieLow, tieHigh].sort(newest).map(r => r.id), [9, 2]);
});

test('seatOf picks the seat of the last attempt, then the first order entry', () => {
  const seatA = { id: 'a', provider: 'officeace' };
  const seatB = { id: 'b', provider: 'workbuddy' };
  assert.equal(seatOf({ tries: [{ id: 'b' }], order: [seatA, seatB] }), seatB);
  assert.equal(seatOf({ tries: [], order: [seatA, seatB] }), seatA);
  assert.equal(seatOf({ tries: [], order: [] }), null);
});

test('quotaOf reports the allowance window the vendor described', () => {
  const quota = quotaOf({
    known: true, used: 11, amount: 5755, limit: 9600, unit: 'credits',
    usedRenews: '2026-11-19T16:00:00Z',
  });
  assert.deepEqual(quota, {
    used: 11, remaining: 89, renewAt: '2026-11-19T16:00:00Z',
    amount: 5755, limit: 9600, unit: 'credits',
  });
});

test('a seat with a zero window has no allowance, not a full one', () => {
  // The regression nail: "known, 0 used, no limit" must not read as 100% left.
  assert.equal(quotaOf({ known: true, used: 0 }), null);
  assert.equal(quotaOf(null), null);
  assert.equal(quotaOf({ used: 10, limit: 10 }), null);
});

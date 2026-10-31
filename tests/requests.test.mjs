// The detail list answers "what happened on this one request", so every row is
// read from its own route and never borrows a number from an older one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRequests } from '../web/requests.mjs';

const at = second => new Date(Date.UTC(2026, 9, 31, 13, 0, second)).toISOString();
const route = (id, extra = {}) => ({
  id,
  time: at(id),
  agent: 'dsh',
  provider: 'officeace',
  served: 'glm-5.3',
  done: true,
  status: 200,
  ms: 3000,
  ttft: 600,
  out: 240,
  flow: 2400,
  reasoning: 0,
  tries: [{ id: `acct${id}`, model: 'glm-5.3', done: true, status: 200, ms: 3000, ttft: 600 }],
  order: [{ id: `acct${id}`, provider: 'officeace', name: 'OfficeAce', kind: 'account', who: `user${id}@example.com`, model: 'glm-5.3' }],
  ...extra,
});

test('only the requested provider and model come back', () => {
  const { rows, total } = modelRequests([
    route(1, { served: 'glm-5.3', provider: 'officeace' }),
    route(2, { served: 'glm-5.3', provider: 'workbuddy',
      order: [{ id: 'acct2', provider: 'workbuddy', name: 'WorkBuddy', kind: 'account', who: 'w', model: 'glm-5.3' }] }),
    route(3, { served: 'deepseek-v3', provider: 'officeace' }),
  ], { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(total, 1);
});

test('rows are newest first and the id settles a same-second tie', () => {
  const stamp = '2026-10-31T13:00:05.000Z';
  const older = route(2, { time: stamp, ms: 2000 });
  const newer = route(9, { time: stamp, ms: 9000 });
  const forwards = modelRequests([older, newer], { providerKey: 'officeace', model: 'glm-5.3' });
  const backwards = modelRequests([newer, older], { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(forwards.rows[0].id, 9);
  assert.deepEqual(backwards.rows.map(r => r.id), forwards.rows.map(r => r.id));
});

test('a full page stops at twenty rows and asks for more', () => {
  const many = Array.from({ length: 25 }, (_, index) => route(index + 1));
  const first = modelRequests(many, { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(first.rows.length, 20);
  assert.equal(first.total, 25);
  assert.equal(first.shown, 20);
  assert.equal(first.hasMore, true);
  assert.equal(first.rows[0].id, 25);
  const second = modelRequests(many, { providerKey: 'officeace', model: 'glm-5.3', pages: 2 });
  assert.equal(second.rows.length, 25);
  assert.equal(second.hasMore, false);
});

test('a model with less than a page shows everything and offers no more', () => {
  const three = [route(1), route(2), route(3)];
  const { rows, total, hasMore } = modelRequests(three, { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(rows.length, 3);
  assert.equal(total, 3);
  assert.equal(hasMore, false);
});

test('a live row keeps none of the metrics of the last completed one', () => {
  const completed = route(1, { ms: 3000, ttft: 600 });
  const live = route(5, { done: false, status: 0, ms: 0, ttft: 900, out: 0, flow: 0,
    tries: [{ id: 'acct5', model: 'glm-5.3', done: false, status: 0, ttft: 900 }] });
  const { rows } = modelRequests([completed, live], { providerKey: 'officeace', model: 'glm-5.3' });
  const row = rows[0];
  assert.equal(row.id, 5);
  assert.equal(row.status, 'live');
  assert.equal(row.ms, null);
  assert.equal(row.speed, null);
  assert.ok(row.ttft === null || row.ttft === 900, `ttft must be the row's own, got ${row.ttft}`);
  assert.notEqual(row.ms, 3000);
});

test('an error outranks a finished ok, whether it is a status or an error text', () => {
  const failed = route(1, { status: 500, ms: 1200 });
  const broken = route(2, { error: '上游 500', status: 200, done: true });
  const { rows } = modelRequests([failed, broken], { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(rows.find(r => r.id === 1).status, 'error');
  assert.equal(rows.find(r => r.id === 2).status, 'error');
});

test('each missing metric is judged on its own', () => {
  const noHead = route(1, { ms: 4200, ttft: 0, out: 0,
    tries: [{ id: 'acct1', model: 'glm-5.3', done: true, status: 200 }] });
  const { rows } = modelRequests([noHead], { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(rows[0].ms, 4200);
  assert.equal(rows[0].ttft, null);
  assert.equal(rows[0].speed, null);
});

test('the clock column is the local wall time, and a broken time reads empty', () => {
  const good = route(1, { time: '2026-11-01T14:32:07+08:00' });
  const bad = route(2, { time: 'not-a-time' });
  const { rows } = modelRequests([good, bad], { providerKey: 'officeace', model: 'glm-5.3' });
  assert.equal(rows.find(r => r.id === 1).clock, '14:32:07');
  assert.equal(rows.find(r => r.id === 2).clock, '');
  assert.equal(rows.find(r => r.id === 1).at, '2026-11-01T14:32:07+08:00');
});

test('empty, missing or unmatched routes answer with an empty list', () => {
  const empty = modelRequests([], { providerKey: 'officeace', model: 'glm-5.3' });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.shown, 0);
  assert.equal(empty.hasMore, false);
  const nothing = modelRequests(undefined, { providerKey: 'officeace', model: 'glm-5.3' });
  assert.deepEqual(nothing.rows, []);
  const miss = modelRequests([route(1)], { providerKey: 'officeace', model: 'gpt-5' });
  assert.equal(miss.rows.length, 0);
});

test('a request that named no provider is grouped under magpie', () => {
  const anonymous = route(1, { provider: '', served: 'glm-5.3', tries: [], order: [] });
  const { rows, total, providerName } = modelRequests([anonymous], { providerKey: 'magpie', model: 'glm-5.3' });
  assert.equal(rows.length, 1);
  assert.equal(total, 1);
  assert.equal(providerName, 'magpie');
});

test('the provider name comes from the query, then the newest seat, then the key', () => {
  const named = route(1, { order: [{ id: 'acct1', provider: 'officeace', name: 'OfficeAce', kind: 'account', who: 'u', model: 'glm-5.3' }] });
  assert.equal(modelRequests([named], { providerKey: 'officeace', model: 'glm-5.3' }).providerName, 'OfficeAce');
  assert.equal(modelRequests([named], { providerKey: 'officeace', model: 'glm-5.3', providerName: 'OfficeAce Plus' }).providerName, 'OfficeAce Plus');
  assert.equal(modelRequests([named], { providerKey: 'officeace', model: 'glm-5.3', providerName: '  ' }).providerName, 'OfficeAce');
});

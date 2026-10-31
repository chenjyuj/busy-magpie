import test from 'node:test';
import assert from 'node:assert/strict';
import { providerSessionGroups } from '../web/model-sessions.mjs';

const at = second => new Date(Date.UTC(2026, 9, 31, 13, 0, second)).toISOString();
const route = (id, extra = {}) => ({
  id,
  time: at(id),
  agent: 'dsh',
  model: `group/m${id}`,
  provider: 'officeace',
  done: true,
  status: 200,
  ms: 3000,
  ttft: 600,
  out: 240,
  flow: 2400,
  reasoning: 0,
  tries: [{ id: `acct${id}`, model: `m${id}`, done: true, status: 200, ms: 3000, ttft: 600 }],
  order: [{ id: `acct${id}`, provider: 'officeace', name: 'OfficeAce', kind: 'account', who: `user${id}@example.com`, model: `m${id}` }],
  ...extra,
});

const withQuota = (r, quota) => ({
  ...r,
  order: r.order.map(seat => ({ ...seat, ...quota })),
});

test('groups by the serving provider, newest group first', () => {
  const { groups } = providerSessionGroups([
    route(1, { provider: 'officeace' }),
    route(5, { provider: 'workbuddy', order: [{ id: 'acct5', provider: 'workbuddy', name: 'WorkBuddy', kind: 'account', who: 'w5', model: 'm5' }] }),
  ]);
  assert.deepEqual(groups.map(g => g.provider), ['WorkBuddy', 'OfficeAce']);
  assert.equal(groups[0].key, 'workbuddy');
});

test('the seat provider wins over the route provider', () => {
  const { groups } = providerSessionGroups([
    route(1, { provider: 'officeace', order: [{ id: 'acct1', provider: 'workbuddy', name: 'WorkBuddy', kind: 'account', who: 'w', model: 'm1' }] }),
  ]);
  assert.equal(groups[0].key, 'workbuddy');
  assert.equal(groups[0].provider, 'WorkBuddy');
});

test('a route with no provider falls into the magpie group', () => {
  const { groups } = providerSessionGroups([
    route(1, { provider: '', order: [{ id: 'acct1', provider: '', kind: 'account', who: 'w', model: 'm1' }] }),
  ]);
  assert.equal(groups[0].key, 'magpie');
});

test('each provider keeps one row per model, newest first', () => {
  const { groups } = providerSessionGroups([
    route(1, { served: 'alpha' }),
    route(2, { served: 'beta' }),
    route(3, { served: 'alpha', ms: 5000 }),
  ]);
  assert.equal(groups.length, 1);
  const models = groups[0].models.map(m => m.model);
  assert.deepEqual(models, ['alpha', 'beta']);
  assert.equal(groups[0].models[0].ms, 5000);
});

test('the quota comes from the provider seat and is clamped to 0-100', () => {
  const { groups } = providerSessionGroups([
    withQuota(route(1, { provider: 'officeace' }), {
      known: true, used: 11, amount: 5755, limit: 9600, unit: 'credits',
      renews: ['2026-11-19T16:00:00Z'], usedRenews: '2026-11-19T16:00:00Z',
    }),
  ]);
  assert.deepEqual(groups[0].quota, {
    remaining: 89, used: 11, amount: 5755, limit: 9600,
    unit: 'credits', renewAt: '2026-11-19T16:00:00Z',
  });
});

test('a seat without known or with a non-finite used has no quota', () => {
  const noKnown = providerSessionGroups([
    withQuota(route(1, { provider: 'a' }), { used: 10, amount: 1, limit: 10, unit: 'x', renews: ['2026-01-01'] }),
  ]);
  assert.equal(noKnown.groups[0].quota, null);
  const badUsed = providerSessionGroups([
    withQuota(route(2, { provider: 'b' }), { known: true, used: 'NaN', amount: 1, limit: 10, renews: [] }),
  ]);
  assert.equal(badUsed.groups[0].quota, null);
});

test('a live request keeps the metrics of the last completed one', () => {
  const { groups } = providerSessionGroups([
    route(1, { served: 'alpha', ms: 3000, ttft: 600 }),
    route(5, { served: 'alpha', done: false, status: 0, ms: 0, ttft: 0, out: 0,
      tries: [{ id: 'acct5', model: 'alpha', done: false, status: 0 }] }),
  ]);
  const row = groups[0].models[0];
  assert.equal(row.status, 'live');
  assert.equal(row.ms, 3000);
  assert.equal(row.ttft, 600);
  assert.equal(Math.round(row.speed), 100);
});

test('a model that has never completed shows no metrics, not zero', () => {
  const { groups } = providerSessionGroups([
    route(1, { provider: 'officeace', served: 'alpha', done: false, status: 0, ms: 0, ttft: 0, out: 0,
      tries: [{ id: 'acct1', model: 'alpha', done: false, status: 0 }] }),
  ]);
  const row = groups[0].models[0];
  assert.equal(row.status, 'live');
  assert.equal(row.ms, null);
  assert.equal(row.ttft, null);
  assert.equal(row.speed, null);
});

test('an error outranks live and ok', () => {
  const p = n => route(Number(n), { provider: `p${n}`, served: `m${n}`,
    order: [{ id: `acct${n}`, provider: `p${n}`, name: `P${n}`, kind: 'account', who: `u${n}`, model: `m${n}` }] });
  const { groups } = providerSessionGroups([
    { ...p('1'), status: 500, error: 'boom' },
    { ...p('2'), done: false, status: 0 },
    p('3'),
  ]);
  assert.equal(groups.find(g => g.key === 'p1').models[0].status, 'error');
  assert.equal(groups.find(g => g.key === 'p2').models[0].status, 'live');
  assert.equal(groups.find(g => g.key === 'p3').models[0].status, 'ok');
});

test('the limit caps model rows, not groups, and counts the rest', () => {
  const many = [];
  for (let i = 1; i <= 8; i++) {
    const p = `p${Math.ceil(i / 3)}`;
    many.push(route(i, { provider: p, served: `m${i}`,
      order: [{ id: `acct${i}`, provider: p, name: p, kind: 'account', who: `u${i}`, model: `m${i}` }] }));
  }
  const capped = providerSessionGroups(many, { limit: 6 });
  const shown = capped.groups.reduce((n, g) => n + g.models.length, 0);
  assert.ok(shown > 0 && shown <= 6, `shown should stay within the cap: ${shown}`);
  assert.equal(capped.hiddenCount, 8 - shown);
  assert.ok(capped.groups.every(g => g.models.length > 0));
});

test('a rerouted request counts the models it moved through', () => {
  const { groups } = providerSessionGroups([
    route(1, { provider: 'officeace', served: 'gamma', tries: [
      { id: 'a', model: 'alpha', done: true, status: 500, fail: true },
      { id: 'b', model: 'beta', done: true, status: 500, fail: true },
      { id: 'c', model: 'gamma', done: true, status: 200 },
    ] }),
  ]);
  assert.equal(groups[0].models[0].model, 'gamma');
  assert.equal(groups[0].models[0].reroutes, 2);
});

test('routes with neither seat nor provider are skipped without crashing', () => {
  const stage = providerSessionGroups([route(1, { served: '', tries: [], order: [] }), route(2, { provider: undefined })]);
  assert.equal(stage.groups.length <= 1, true);
});

test('the group carries the account of its most recent seat', () => {
  const { groups } = providerSessionGroups([
    route(1, { provider: 'officeace', order: [{ id: 'acct1', provider: 'officeace', name: 'OfficeAce', kind: 'account', who: 'first@example.com', model: 'm1' }] }),
    route(3, { provider: 'officeace', order: [{ id: 'acct3', provider: 'officeace', name: 'OfficeAce', kind: 'account', who: 'last@example.com', model: 'm3' }] }),
  ]);
  assert.equal(groups[0].account, 'last@example.com');
  assert.equal(groups[0].at, at(3));
});
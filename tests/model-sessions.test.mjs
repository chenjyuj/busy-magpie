import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSessionRows } from '../web/model-sessions.mjs';

const at = second => new Date(Date.UTC(2026, 9, 31, 3, 0, second)).toISOString();
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
  tries: [{ id: `acct${id}`, model: `m${id}`, done: true, status: 200 }],
  order: [{ id: `acct${id}`, provider: 'officeace', kind: 'account', who: `who${id}`, model: `m${id}` }],
  ...extra,
});

test('one row per served model, newest activity first', () => {
  const rows = modelSessionRows([route(1, { served: 'alpha' }), route(2, { served: 'beta' })]).rows;
  assert.deepEqual(rows.map(row => row.model), ['beta', 'alpha']);
  assert.equal(rows[0].key, 'beta');
});

test('the served model wins over the model of the last attempt', () => {
  const rows = modelSessionRows([route(1, { served: 'alpha', tries: [{ id: 'a', model: 'beta', done: true, status: 200 }] })]).rows;
  assert.equal(rows[0].model, 'alpha');
});

test('the last attempt names the model when served is absent', () => {
  const rows = modelSessionRows([route(1, {
    served: '',
    tries: [{ id: 'a', model: 'beta', done: true, status: 200 }, { id: 'b', model: 'gamma', done: true, status: 200 }],
  })]).rows;
  assert.equal(rows[0].model, 'gamma');
});

test('grouping uses the model name alone, not the account behind it', () => {
  const rows = modelSessionRows([
    route(1, { served: 'alpha', provider: 'officeace' }),
    route(2, { served: 'alpha', provider: 'workbuddy', order: [{ id: 'acct2', provider: 'workbuddy', kind: 'account', who: 'other' }] }),
  ]).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'workbuddy');
  assert.equal(rows[0].account, 'other');
});

test('a model keeps only its newest request', () => {
  const rows = modelSessionRows([route(1, { served: 'alpha', ms: 1111 }), route(5, { served: 'alpha', ms: 2222 })]).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ms, 2222);
});

test('a rerouted request belongs to its last attempt and counts the reroutes', () => {
  const rows = modelSessionRows([route(1, {
    served: '',
    tries: [
      { id: 'a', model: 'alpha', done: true, status: 500, fail: true },
      { id: 'b', model: 'beta', done: true, status: 500, fail: true },
      { id: 'c', model: 'gamma', done: true, status: 200 },
    ],
  })]).rows;
  assert.equal(rows[0].model, 'gamma');
  assert.equal(rows[0].reroutes, 2);
});

test('a route with neither a served model nor an attempt produces no row and does not throw', () => {
  const stage = modelSessionRows([route(1, { served: '', tries: [] }), route(2, { served: undefined, tries: undefined })]);
  assert.deepEqual(stage.rows, []);
  assert.equal(stage.hiddenCount, 0);
});

test('missing metrics stay null instead of zero', () => {
  const rows = modelSessionRows([route(1, { served: 'alpha', ms: 0, ttft: 0, out: 0 })]).rows;
  assert.equal(rows[0].ms, null);
  assert.equal(rows[0].ttft, null);
  assert.equal(rows[0].out, null);
  assert.equal(rows[0].speed, null);
});

test('the status is error first, then live, then done', () => {
  const rows = modelSessionRows([
    route(1, { served: 'alpha', status: 500, error: 'boom' }),
    route(2, { served: 'beta', done: false, status: 0, ms: 0, ttft: 0, out: 0 }),
    route(3, { served: 'gamma', done: true, status: 200 }),
  ]).rows;
  const byModel = Object.fromEntries(rows.map(row => [row.model, row.status]));
  assert.equal(byModel.alpha, 'error');
  assert.equal(byModel.beta, 'live');
  assert.equal(byModel.gamma, 'ok');
});

test('the list caps at six rows and reports the rest as hidden', () => {
  const many = Array.from({ length: 7 }, (_, index) => route(index + 1, { served: `m${index + 1}` }));
  const capped = modelSessionRows(many);
  assert.equal(capped.rows.length, 6);
  assert.equal(capped.hiddenCount, 1);
  const smaller = modelSessionRows(many, { limit: 2 });
  assert.equal(smaller.rows.length, 2);
  assert.equal(smaller.hiddenCount, 5);
});

test('each row carries the account, timing and activity the card shows', () => {
  const rows = modelSessionRows([route(3, { served: 'alpha', account: undefined, folder: 'x' })]).rows;
  assert.equal(rows[0].provider, 'officeace');
  assert.equal(rows[0].account, 'who3');
  assert.equal(rows[0].at, at(3));
  assert.equal(rows[0].ttft, 600);
  assert.equal(rows[0].out, 240);
  assert.equal(Math.round(rows[0].speed), 100);
  assert.equal(rows[0].route.id, 3);
});
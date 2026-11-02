// The plan windows magpie reports for an account, read the way the card needs
// them: which window is holding, how each window is labelled, and which plan
// belongs to which account. Pure functions, no window, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowQuota, windowLabel, primaryWindow, planOf, planForGroup, plansByProvider,
} from '../web/plan-quota.mjs';

const plan = (windows, extra = {}) => ({
  provider: 'opencode-go',
  name: 'opencode go',
  kind: 'plan',
  user: '6',
  windows,
  ...extra,
});

const hours = { name: '5 hours', used: 5, remaining: 95, resetsAt: '2026-11-02T06:13:57Z', holdsWhy: 'none' };
const days = { name: '7 days', used: 2, remaining: 98, resetsAt: '2026-11-09T00:00:00Z', holdsWhy: 'low' };
const month = { name: 'Month', used: 6, remaining: 94, resetsAt: '2026-11-30T07:39:30Z', holdsWhy: 'clock' };

test('windowQuota keeps the shares the vendor reported and clamps an overshoot', () => {
  const quota = windowQuota(hours);
  assert.equal(quota.remaining, 95);
  assert.equal(quota.used, 5);
  assert.equal(quota.renewAt, '2026-11-02T06:13:57Z');
  assert.equal(quota.name, '5 hours');
  assert.equal(quota.unit, '');
  assert.equal(windowQuota({ name: 'Month', used: 140, remaining: -4 }).remaining, 0);
  assert.equal(windowQuota({ name: 'Month', used: 140, remaining: -4 }).used, 100);
  assert.equal(windowQuota(null), null);
  assert.equal(windowQuota({ name: 'Month' }), null, 'a window with no share is not a window');
});

test('windowQuota falls back to the complement when only one share was reported', () => {
  assert.equal(windowQuota({ name: 'Month', used: 6 }).remaining, 94);
  assert.equal(windowQuota({ name: 'Month', remaining: 94 }).used, 6);
});

test("windowLabel shortens a plan's time windows and keeps every other name", () => {
  assert.equal(windowLabel(hours), '5H');
  assert.equal(windowLabel(days), '7D');
  assert.equal(windowLabel(month), '本月');
  assert.equal(windowLabel({ name: 'Credits' }), 'Credits');
  assert.equal(windowLabel({ name: '每日赠送 · 临期·1天' }), '每日赠送 · 临期·1天');
  assert.equal(windowLabel(null), '');
});

test('primaryWindow prefers the window magpie marked as holding', () => {
  const windows = [hours, days, month].map(windowQuota);
  assert.equal(primaryWindow(windows), windows[2]);
  assert.equal(primaryWindow([]), null);
});

test('primaryWindow falls back to the window closest to running out', () => {
  const windows = [
    windowQuota({ name: '5 hours', remaining: 95 }),
    windowQuota({ name: '7 days', remaining: 98 }),
    windowQuota({ name: 'Month', remaining: 94 }),
  ];
  assert.equal(primaryWindow(windows), windows[2]);
});

test('planOf reads a plan and its windows, and refuses anything that is not one', () => {
  const read = planOf(plan([hours, days, month], { last: true, lastServedAt: '2026-11-02T02:23:54Z' }));
  assert.equal(read.provider, 'opencode-go');
  assert.equal(read.user, '6');
  assert.equal(read.windows.length, 3);
  assert.equal(read.primary.remaining, 94);
  assert.equal(read.last, true);
  assert.equal(read.lastServedAt, Date.parse('2026-11-02T02:23:54Z'));
  assert.equal(planOf({ kind: 'subscription', windows: [hours] }), null, 'a subscription is not a plan');
  assert.equal(planOf({ kind: 'plan', windows: [] }), null);
  assert.equal(planOf({ kind: 'plan', windows: [{ name: 'Month' }] }), null);
  assert.equal(planOf(null), null);
});

test("planForGroup picks the account's own plan, then the one magpie last served", () => {
  const byProvider = plansByProvider([
    plan([hours, days, month], { user: '1' }),
    plan([hours, days, month], { user: '6', last: true }),
  ]);
  assert.equal(planForGroup(byProvider, 'opencode-go', '1').user, '1');
  assert.equal(planForGroup(byProvider, 'opencode-go', '6').user, '6');
  assert.equal(planForGroup(byProvider, 'opencode-go', '').user, '6', 'no account names the last served plan');
  assert.equal(planForGroup(byProvider, 'opencode-go', '9'), byProvider.get('opencode-go')[1]);
  assert.equal(planForGroup(byProvider, 'nope', '1'), null);
});

test('plansByProvider groups the answer by provider key and drops what it cannot read', () => {
  const byProvider = plansByProvider([
    plan([hours, days, month], { user: '6', last: true }),
    plan([hours, days, month], { user: '2' }),
    { kind: 'subscription', provider: 'workbuddy', name: 'WorkBuddy', windows: [hours] },
    { kind: 'plan', provider: 'raccoon', windows: [] },
    null,
  ]);
  assert.deepEqual([...byProvider.keys()], ['opencode-go']);
  assert.equal(byProvider.get('opencode-go').length, 2);
  assert.equal(plansByProvider(null).size, 0);
});

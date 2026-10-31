import test from 'node:test';
import assert from 'node:assert/strict';
import { speedInfo, timingInfo } from '../web/timing.mjs';

const route = extra => ({ done: true, out: 240, ms: 3000, ttft: 600, firstText: 600, reasoning: 0, flow: 2400, ...extra });

test('a streamed reply reports output tokens per second over its streaming window', () => {
  const speed = speedInfo(route(), null);
  assert.ok(speed);
  assert.equal(Math.round(speed.rate), 100);
  assert.equal(speed.tokens, 240);
  assert.equal(speed.window, 2400);
});

test('a reply that arrived in one burst at its end has no speed', () => {
  assert.equal(speedInfo(route({ flow: 10 }), null), null);
});

test('a reply that is still streaming has no speed', () => {
  assert.equal(speedInfo(route({ done: false }), null), null);
});

test('a missing first byte or output count yields no speed instead of zero', () => {
  assert.equal(speedInfo(route({ ttft: 0 }), null), null);
  assert.equal(speedInfo(route({ out: 0 }), null), null);
});

test('a missing route first byte falls back to the last try, and an idle request has no timing', () => {
  const speed = speedInfo(route({ ttft: 0 }), { ttft: 600 });
  assert.ok(speed);
  assert.equal(Math.round(speed.rate), 100);

  const timing = timingInfo(route({ ttft: 0 }), { ttft: 600, net: { wait: 120, own: 30 } });
  assert.equal(timing.ms, 3000);
  assert.equal(timing.ttft, 600);
  assert.equal(timing.wait, 120);
  assert.equal(timing.own, 30);
  assert.ok(timing.speed);

  assert.equal(timingInfo({ ms: 0, ttft: 0 }, null), null);
});
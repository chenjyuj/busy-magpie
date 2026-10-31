'use strict';
// Where the detail window goes: beside the card when there is room, flipped to
// the other side when there is not, and always inside the work area.
const test = require('node:test');
const assert = require('node:assert/strict');
const {placeDetail} = require('../src/detail-placement.cjs');

const card = (extra = {}) => ({x: 100, y: 100, width: 600, height: 400, ...extra});
const area = (extra = {}) => ({x: 0, y: 0, width: 1920, height: 1040, ...extra});
const size = {width: 420, height: 520};

test('a card with room to its right gets the window on the right', () => {
  assert.deepEqual(placeDetail(size, card(), area()), {x: 712, y: 100});
});

test('a card near the right edge flips the window to its left', () => {
  const placed = placeDetail(size, card({x: 1400}), area());
  assert.equal(placed.x, 1400 - 12 - 420);
});

test('a card with room on neither side pins the window to the work area edge', () => {
  const placed = placeDetail(size, card({x: 0, width: 1900, height: 400}), area());
  assert.equal(placed.x, 0);
});

test('a card near the bottom lifts the window above the work area edge', () => {
  const placed = placeDetail(size, card({y: 900}), area());
  assert.equal(placed.y, 1040 - 520);
});

test('a card above the work area pushes the window back down', () => {
  const placed = placeDetail(size, card({y: -50}), area());
  assert.equal(placed.y, 0);
});

test('a work area that does not start at the origin is measured from its own corner', () => {
  const second = area({x: 1920, width: 1920});
  const placed = placeDetail(size, card({x: 2020, y: 100}), second);
  assert.equal(placed.x, 1920 + 712);
  assert.equal(placed.y, 100);
});

test('the answer is always whole pixels', () => {
  const placed = placeDetail(size, card({x: 100.4, y: 100.6, width: 600.2}), area({x: 0.2, y: 0.4}), 12.5);
  assert.ok(Number.isInteger(placed.x), `x should be an integer, got ${placed.x}`);
  assert.ok(Number.isInteger(placed.y), `y should be an integer, got ${placed.y}`);
  assert.deepEqual(placed, {x: 713, y: 101});
});

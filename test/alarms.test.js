'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AlarmEngine, globToRegExp } = require('../src/alarms');

const rule = { id: 'hot', point: 'rack*.temp', op: '>', value: 27, deadband: 0.5, delaySec: 10, severity: 'warning', message: '{device}: {value}' };
const snap = (ts, values, devices = {}) => ({ ts, values, devices });

test('glob matches only within one path segment', () => {
  const re = globToRegExp('rack*.temp');
  assert.ok(re.test('rack1.temp'));
  assert.ok(!re.test('rack1.humidity'));
  assert.ok(!re.test('crah1.temp'));
});

test('alarm waits for delay, respects deadband, retires after clear + ack', () => {
  const eng = new AlarmEngine([rule], { deviceNames: { rack1: 'Rack R1' } });
  const events = [];
  eng.on('event', e => events.push(e.type));

  eng.evaluate(snap(0, { 'rack1.temp': 28 }));
  eng.evaluate(snap(5000, { 'rack1.temp': 28 }));
  assert.equal(eng.list().length, 0, 'not raised before delay');

  eng.evaluate(snap(10000, { 'rack1.temp': 28.4 }));
  let [a] = eng.list();
  assert.equal(a.message, 'Rack R1: 28,4');
  assert.equal(a.clearedAt, null);

  eng.evaluate(snap(12000, { 'rack1.temp': 26.8 }));
  assert.equal(eng.list()[0].clearedAt, null, 'inside deadband: still active');

  eng.evaluate(snap(14000, { 'rack1.temp': 26.4 }));
  [a] = eng.list();
  assert.equal(a.clearedAt, 14000, 'cleared below threshold - deadband');
  assert.equal(eng.list().length, 1, 'cleared but unacked stays visible');

  eng.ack(a.id, 'tester', 15000);
  assert.equal(eng.list().length, 0);
  assert.deepEqual(events, ['raised', 'cleared', 'acked']);
});

test('brief spike shorter than delay does not raise', () => {
  const eng = new AlarmEngine([rule]);
  eng.evaluate(snap(0, { 'rack2.temp': 30 }));
  eng.evaluate(snap(4000, { 'rack2.temp': 25 }));
  eng.evaluate(snap(12000, { 'rack2.temp': 30 }));
  assert.equal(eng.list().length, 0);
});

test('acked active alarm stays until cleared', () => {
  const eng = new AlarmEngine([{ ...rule, delaySec: 0 }]);
  eng.evaluate(snap(0, { 'rack3.temp': 29 }));
  const [a] = eng.list();
  eng.ack(a.id, 'op', 1000);
  assert.equal(eng.list().length, 1);
  eng.evaluate(snap(2000, { 'rack3.temp': 20 }));
  assert.equal(eng.list().length, 0);
});

test('equality rule and comm-loss rule', () => {
  const eng = new AlarmEngine([
    { id: 'leak', point: 'leak1.detected', op: '==', value: 1, delaySec: 0, severity: 'critical', message: 'leak' },
    { id: 'comm', type: 'comm', delaySec: 6, severity: 'warning', message: '{device} offline' },
  ], { deviceNames: { rack4: 'Rack R4' } });
  eng.evaluate(snap(0, { 'leak1.detected': 1 }, { rack4: { status: 'offline' } }));
  assert.deepEqual(eng.list().map(a => a.ruleId), ['leak']);
  eng.evaluate(snap(6000, { 'leak1.detected': 1 }, { rack4: { status: 'offline' } }));
  const list = eng.list();
  assert.deepEqual(list.map(a => a.ruleId), ['leak', 'comm'], 'sorted by severity');
  assert.equal(list[1].message, 'Rack R4 offline');
});

test('lower-severity alarm is hidden while a higher one on the same point is active', () => {
  const crit = { ...rule, id: 'crit', value: 32, delaySec: 0, severity: 'critical' };
  const eng = new AlarmEngine([{ ...rule, delaySec: 0, suppressedBy: 'crit' }, crit]);
  eng.evaluate(snap(0, { 'rack1.temp': 29 }));
  assert.deepEqual(eng.list().map(a => a.ruleId), ['hot']);
  eng.evaluate(snap(1000, { 'rack1.temp': 35 }));
  assert.deepEqual(eng.list().map(a => a.ruleId), ['crit']);
  assert.equal(eng.list()[0].message, 'rack1: 35', 'message tracks live value');
  eng.evaluate(snap(2000, { 'rack1.temp': 29 }));
  assert.deepEqual(eng.list().map(a => a.ruleId).sort(), ['crit', 'hot'], 'crit cleared-unacked, hot visible again');
});

test('missing value (device offline) neither raises nor clears', () => {
  const eng = new AlarmEngine([{ ...rule, delaySec: 0 }]);
  eng.evaluate(snap(0, { 'rack4.temp': 30 }));
  eng.evaluate(snap(2000, {}));
  assert.equal(eng.list()[0].clearedAt, null);
});

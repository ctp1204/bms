'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const I18N = require('../public/i18n');
const { LANGS, loc, formatNumber } = require('../src/locale');
const { FAULTS } = require('../sim/plant');
const { AlarmEngine } = require('../src/alarms');

const devices = require(path.join(__dirname, '../config/devices.json'));
const rules = require(path.join(__dirname, '../config/alarms.json'));
const vars = s => (s.match(/\{\w+\}/g) || []).sort();

test('server and UI support the same languages', () => {
  assert.deepEqual(Object.keys(I18N).sort(), [...LANGS].sort());
});

test('every UI key exists in every language with the same placeholders', () => {
  const base = I18N.vi;
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(I18N[lang]).sort(), Object.keys(base).sort(), `keys differ in ${lang}`);
    for (const [k, v] of Object.entries(base)) {
      assert.ok(I18N[lang][k].trim(), `${lang}.${k} is empty`);
      assert.deepEqual(vars(I18N[lang][k]), vars(v), `placeholders differ in ${lang}.${k}`);
    }
  }
});

// Mọi chuỗi đa ngôn ngữ trong config phải có đủ ngôn ngữ và cùng biến
function checkLocalized(value, where) {
  if (typeof value === 'string') return;
  for (const lang of LANGS) assert.ok(value[lang] && value[lang].trim(), `${where}: missing ${lang}`);
  for (const lang of LANGS) assert.deepEqual(vars(value[lang]), vars(value.vi), `${where}: placeholders differ in ${lang}`);
}

test('config and simulator texts are translated', () => {
  checkLocalized(devices.site.name, 'site.name');
  for (const d of devices.devices) {
    checkLocalized(d.name, d.id);
    for (const p of d.points) {
      checkLocalized(p.name, `${d.id}.${p.key}`);
      for (const [k, v] of Object.entries(p.enum || {})) checkLocalized(v, `${d.id}.${p.key}.enum.${k}`);
    }
  }
  for (const p of devices.derived) checkLocalized(p.name, p.id);
  for (const r of rules) checkLocalized(r.message, `alarm ${r.id}`);
  for (const [id, label] of Object.entries(FAULTS)) checkLocalized(label, `fault ${id}`);
});

test('loc and formatNumber', () => {
  assert.equal(loc({ vi: 'Tải', ja: '負荷' }, 'ja'), '負荷');
  assert.equal(loc({ vi: 'Tải' }, 'ja'), 'Tải', 'falls back to vi');
  assert.equal(loc('CRAH-1', 'ja'), 'CRAH-1');
  assert.equal(formatNumber(28.4, 'vi'), '28,4');
  assert.equal(formatNumber(28.4, 'ja'), '28.4');
});

test('alarm messages are produced in every language', () => {
  const rule = rules.find(r => r.id === 'rack_hot_warn');
  const eng = new AlarmEngine([{ ...rule, delaySec: 0 }], {
    deviceNames: { rack1: { vi: 'Rack R1', ja: 'ラック R1' } },
    langs: LANGS,
  });
  eng.evaluate({ ts: 0, values: { 'rack1.temp': 28.4 }, devices: {} });
  const [a] = eng.list();
  assert.equal(a.messages.vi, 'Rack R1: nhiệt độ inlet 28,4°C vượt 27°C (ngưỡng khuyến nghị ASHRAE)');
  assert.equal(a.messages.ja, 'ラック R1: 吸気温度 28.4°C が 27°C を超過（ASHRAE 推奨上限）');
  assert.equal(a.message, a.messages.vi, 'default language is the first one');
});

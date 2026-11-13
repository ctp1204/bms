'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const dcim = require(path.join(__dirname, '../config/dcim.json'));
const devices = require(path.join(__dirname, '../config/devices.json')).devices;
const alarms = require(path.join(__dirname, '../config/alarms.json'));
const { Plant, RACK_WEIGHTS } = require('../sim/plant');

const types = Object.fromEntries(Object.entries(dcim.deviceTypes).filter(([k]) => !k.startsWith('$')));
const rackKw = r => r.devices.reduce((s, d) => s + types[d.type].ratedKw, 0);
const round1 = x => Math.round(x * 10) / 10;

test('racks match the six rack sensors in devices.json, in order', () => {
  const sensors = devices.filter(d => d.type === 'rack_sensor').sort((a, b) => a.position - b.position).map(d => d.id);
  assert.deepEqual(dcim.racks.map(r => r.rack), sensors);
});

test('sample devices use known types, have unique names and 3-5 per rack', () => {
  const names = dcim.racks.flatMap(r => r.devices.map(d => d.name));
  assert.equal(new Set(names).size, names.length, 'device names must be unique');
  for (const r of dcim.racks) {
    assert.ok(r.devices.length >= 3 && r.devices.length <= 5, `${r.rack}: ${r.devices.length} devices`);
    for (const d of r.devices) assert.ok(types[d.type], `${d.name}: unknown type ${d.type}`);
  }
  for (const [k, t] of Object.entries(types)) {
    assert.ok(t.name.vi && t.name.ja, `${k}: name needs vi and ja`);
    assert.ok(t.ratedKw > 0 && Number.isInteger(t.u) && t.u >= 0, `${k}: bad ratedKw/u`);
  }
});

test('devices fit inside the rack and never overlap', () => {
  for (const r of dcim.racks) {
    const used = new Map();
    for (const d of r.devices) {
      const { u } = types[d.type];
      assert.ok(u > 0, `${d.name}: only rack-mounted types can be placed by position`);
      assert.ok(d.position >= 1 && d.position + u - 1 <= dcim.rack.uHeight, `${d.name}: outside 1..${dcim.rack.uHeight}U`);
      for (let i = d.position; i < d.position + u; i++) {
        assert.ok(!used.has(i), `${r.rack}: U${i} used by ${used.get(i)} and ${d.name}`);
        used.set(i, d.name);
      }
    }
  }
});

test('every rack stays within budget, with one nearly full and one nearly empty (demo intent)', () => {
  const pct = dcim.racks.map(r => (rackKw(r) / dcim.rack.budgetKw) * 100);
  for (const [i, p] of pct.entries()) assert.ok(p <= 100, `${dcim.racks[i].rack}: ${p.toFixed(0)}% of budget`);
  assert.ok(pct.some(p => p > dcim.rack.critPct - 5), 'need a rack close to full');
  assert.ok(pct.some(p => p < 20), 'need a rack that is nearly empty');
  assert.ok(dcim.rack.warnPct < dcim.rack.critPct && dcim.rack.critPct < 100);
  assert.deepEqual(dcim.racks.map(r => round1(rackKw(r))), [27.4, 24.2, 21, 31.2, 17.8, 3.6]);
});

test('PDU rating agrees with the PDU alarm thresholds in alarms.json', () => {
  const at = id => alarms.find(a => a.id === id).value;
  const rated = dcim.power.pduRatedKw;
  assert.equal(at('pdu_redundancy'), rated * dcim.power.redundancyMaxPct / 100);
  assert.equal(at('pdu_overload'), rated * 0.8);
  assert.equal(at('pdu_overload_crit'), rated * 0.95);
  assert.ok(dcim.power.rackPduRatedKw >= dcim.rack.budgetKw, 'one rack PDU must carry the whole rack when the other side is lost');
});

test('each rack feed delivers the rack budget (as NetBox computes it) and every role is defined', () => {
  const f = dcim.power.feed;
  const phases = f.phase === 'three-phase' ? Math.sqrt(3) : 1;
  const availableKw = (phases * f.voltage * f.amperage * f.maxUtilization / 100) / 1000;
  assert.ok(Math.abs(availableKw - dcim.rack.budgetKw) < 0.5, `feed gives ${availableKw.toFixed(1)} kW, budget ${dcim.rack.budgetKw} kW`);
  const roles = Object.keys(dcim.roles).filter(k => !k.startsWith('$'));
  const used = [...Object.values(types).map(t => t.role),
    ...Object.entries(dcim.infra).filter(([k, m]) => !k.startsWith('$') && m.kind === 'device').map(([, m]) => m.role)];
  for (const r of used) assert.ok(roles.includes(r), `role ${r} is not defined in dcim.roles`);
  for (const r of roles) assert.match(dcim.roles[r].color, /^[0-9a-f]{6}$/);
  for (const [k, m] of Object.entries(dcim.infra)) if (!k.startsWith('$') && m.kind === 'device') assert.ok(m.model, `${k}: device needs a model`);
});

test('power chain and infra mapping reference real devices and cover every device type', () => {
  const ids = new Set(devices.map(d => d.id));
  for (const id of [dcim.power.msb, dcim.power.ups, ...dcim.power.feeds.map(f => f.pdu)]) assert.ok(ids.has(id), `unknown device ${id}`);
  assert.deepEqual(dcim.power.feeds.map(f => f.side), ['A', 'B']);
  const infra = Object.keys(dcim.infra).filter(k => !k.startsWith('$'));
  assert.deepEqual(infra.sort(), [...new Set(devices.map(d => d.type))].sort());
  for (const k of infra) {
    const m = dcim.infra[k];
    assert.ok(['rack', 'power-panel', 'device'].includes(m.kind), `${k}: bad kind`);
    if (m.kind === 'device') assert.ok(m.role, `${k}: device needs a role`);
  }
});

test('simulator splits IT load by rated power and keeps the total unchanged', () => {
  const total = dcim.racks.reduce((s, r) => s + rackKw(r), 0);
  assert.ok(Math.abs(RACK_WEIGHTS.reduce((s, w) => s + w, 0) - 1) < 1e-9);
  dcim.racks.forEach((r, i) => assert.ok(Math.abs(RACK_WEIGHTS[i] - rackKw(r) / total) < 1e-9));
  const plant = new Plant({ random: () => 0.5 });
  const sum = plant.rackKw.reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(sum - 120) < 1e-9, `rack total ${sum} kW`);
  assert.ok(plant.rackKw[3] > 28 && plant.rackKw[5] < 4, 'R4 near full, R6 nearly empty');
});

test('demo questions: one 8-GPU server fits in R6 but not R4; two break 2N on the floor PDUs', () => {
  const gpu8 = types.gpu8.ratedKw;
  const free = r => dcim.rack.budgetKw - rackKw(dcim.racks.find(x => x.rack === r));
  assert.ok(free('rack4') < gpu8, 'R4 should not have room for an 8-GPU server');
  assert.ok(free('rack6') > 2 * gpu8, 'R6 should have room for two');
  // 2N: mỗi PDU sàn gánh một nửa tải IT (120 kW), không được vượt redundancyMaxPct
  const limit = dcim.power.pduRatedKw * dcim.power.redundancyMaxPct / 100;
  assert.ok(120 / 2 + gpu8 / 2 <= limit, 'one more 8-GPU server keeps 2N');
  assert.ok(120 / 2 + gpu8 > limit, 'two more 8-GPU servers lose 2N');
});

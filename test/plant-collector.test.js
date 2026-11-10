'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Plant } = require('../sim/plant');
const { Collector, decodeDevice, derive } = require('../src/collector');
const { History } = require('../src/history');
const { createServer, ModbusTcpClient, ModbusException, EXCEPTION } = require('../src/modbus');

const cfg = require(path.join(__dirname, '../config/devices.json'));

// RNG có seed để test lặp lại được
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const run = (plant, seconds) => {
  for (let i = 0; i < seconds * 2; i++) plant.step(0.5);
};

test('plant holds room near setpoint in normal operation', () => {
  const p = new Plant({ random: seeded(1) });
  run(p, 900);
  assert.ok(p.room > 23 && p.room < 25.5, `room=${p.room}`);
  const pue = p.facilityKw / p.itKw;
  assert.ok(pue > 1.2 && pue < 1.6, `pue=${pue}`);
});

test('losing one CRAH overheats the room (no N+1 redundancy in demo)', () => {
  const p = new Plant({ random: seeded(2) });
  run(p, 120);
  p.setFault('crah1_fail', true);
  run(p, 300);
  assert.equal(p.crah[0].status, 2);
  assert.ok(p.room > 27, `room=${p.room}`);
});

test('chiller trip warms chilled water', () => {
  const p = new Plant({ random: seeded(3) });
  run(p, 60);
  p.setFault('chiller_fail', true);
  run(p, 120);
  assert.ok(p.chiller.chwSupply > 12, `chw=${p.chiller.chwSupply}`);
});

test('every configured device maps to plant registers of the right length', () => {
  const p = new Plant({ random: seeded(4) });
  run(p, 10);
  for (const d of cfg.devices) {
    const regs = p.registers(d.unit);
    assert.ok(regs, `unit ${d.unit} missing`);
    assert.ok(regs.length >= d.start + d.count, `unit ${d.unit} too short`);
  }
});

test('decodeDevice applies scale and sign; derive computes PUE and inlet stats', () => {
  const crah = cfg.devices.find(d => d.id === 'crah1');
  assert.deepEqual(decodeDevice(crah, [0xffec, 345, 60, 1, 32]), {
    'crah1.supply_temp': -2,
    'crah1.return_temp': 34.5,
    'crah1.fan_speed': 60,
    'crah1.status': 1,
    'crah1.power_kw': 3.2,
  });
  const d = derive(cfg.devices, {
    'pm1.it_kw': 100, 'pm1.facility_kw': 140, 'rack1.temp': 24, 'rack2.temp': 26,
    'crah1.power_kw': 3, 'chiller1.power_kw': 20,
  });
  assert.deepEqual(d, { 'site.pue': 1.4, 'site.cooling_kw': 23, 'site.inlet_avg': 25, 'site.inlet_max': 26 });
});

test('collector reads the simulated plant end-to-end and marks offline devices', async () => {
  const plant = new Plant({ random: seeded(5) });
  run(plant, 30);
  plant.setFault('rack4_sensor_offline', true);
  const server = createServer(({ unit, address, quantity }) => {
    const regs = plant.registers(unit);
    if (!regs) throw new ModbusException(EXCEPTION.GATEWAY_TARGET_FAILED);
    return regs.slice(address, address + quantity);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new ModbusTcpClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 500 });
  try {
    const col = new Collector({ client, devices: cfg.devices });
    const snap = await col.tick();
    assert.equal(snap.devices.rack4.status, 'offline');
    assert.equal(snap.devices.rack1.status, 'online');
    assert.equal(snap.values['rack4.temp'], undefined);
    assert.ok(Math.abs(snap.values['rack1.temp'] - plant.racks[0].temp) < 0.06);
    assert.ok(snap.values['site.pue'] > 1.2);
  } finally {
    client.close();
    await new Promise(r => server.close(r));
  }
});

test('history caps size and downsamples', () => {
  const h = new History(1000);
  for (let i = 0; i < 1500; i++) h.push(i, { x: i });
  assert.equal(h.samples.length, 1000);
  const rows = h.query('x', 0, 100);
  assert.equal(rows.length, 100);
  assert.equal(rows[0][1], 504.5);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Plant, SRC, GEN, UPS } = require('../sim/plant');
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
    'ups1.out_kw': 100, 'msb1.kw': 140, 'rack1.temp': 24, 'rack2.temp': 26,
    'crah1.power_kw': 3, 'chiller1.power_kw': 20,
  });
  assert.deepEqual(d, { 'site.it_kw': 100, 'site.pue': 1.4, 'site.cooling_kw': 23, 'site.inlet_avg': 25, 'site.inlet_max': 26 });
  // Mất nguồn: tổng điện MSB = 0 thì không tính PUE
  assert.equal(derive(cfg.devices, { 'ups1.out_kw': 100, 'msb1.kw': 0 })['site.pue'], undefined);
});

test('decodeDevice reads 32-bit kWh from two registers (high word first)', () => {
  const msb = cfg.devices.find(d => d.id === 'msb1');
  const kwh = 1250123;
  const v = decodeDevice(msb, [400, 200, 1300, 95, 5000, 25, kwh >>> 16, kwh & 0xffff]);
  assert.equal(v['msb1.kwh'], kwh);
  assert.equal(v['msb1.pf'], 0.95);
  assert.equal(v['msb1.freq'], 50);
});

test('utility outage: UPS on battery, cooling stops, generator takes over, then retransfer', () => {
  const p = new Plant({ random: seeded(6) });
  run(p, 60);
  p.setFault('utility_outage', true);
  run(p, 2);
  assert.equal(p.power.ats.source, SRC.NONE, 'gap before generator is up');
  assert.equal(p.power.ups.mode, UPS.BATTERY);
  assert.ok(p.itKw > 100, 'IT stays up on battery');
  assert.equal(p.crah[0].status, 0, 'CRAH not on UPS: stops');
  assert.equal(p.facilityKw, 0);
  run(p, 12);
  assert.equal(p.power.gen.status, GEN.RUNNING);
  assert.equal(p.power.ats.source, SRC.GEN);
  assert.equal(p.power.ups.mode, UPS.ONLINE);
  assert.equal(p.crah[0].status, 1);
  assert.equal(p.chiller.status, 0, 'chiller waits to restart');
  run(p, 40);
  assert.equal(p.chiller.status, 1);
  p.setFault('utility_outage', false);
  run(p, 10);
  assert.equal(p.power.ats.source, SRC.GEN, 'waits for utility to be stable');
  run(p, 10);
  assert.equal(p.power.ats.source, SRC.UTIL);
  assert.equal(p.power.ats.transfers, 2);
  run(p, 40);
  assert.equal(p.power.gen.status, GEN.STANDBY, 'generator cools down then stops');
});

test('generator fails to start: battery drains and IT load is lost', () => {
  const p = new Plant({ random: seeded(7) });
  run(p, 30);
  p.setFault('gen_fail_start', true);
  p.setFault('utility_outage', true);
  run(p, 5);
  assert.equal(p.power.gen.status, GEN.FAULT);
  assert.equal(p.power.ats.source, SRC.NONE);
  run(p, 1500);
  assert.equal(p.power.ups.battery, 0);
  assert.equal(p.itKw, 0);
});

test('PDU-A input lost: PDU-B carries every rack', () => {
  const p = new Plant({ random: seeded(8) });
  run(p, 30);
  const [a0, b0] = p.power.pdu.map(d => d.total);
  assert.ok(Math.abs(a0 - b0) < 0.01, 'normally split 50/50');
  p.setFault('pdu_a_fail', true);
  run(p, 1);
  assert.equal(p.power.pdu[0].status, 1);
  assert.equal(p.power.pdu[0].total, 0);
  assert.ok(Math.abs(p.power.pdu[1].total - p.itKw) < 0.01);
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

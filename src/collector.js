'use strict';
// Thu thập dữ liệu: định kỳ đọc từng thiết bị qua Modbus, đổi thanh ghi thô ra giá trị kỹ thuật,
// tính các chỉ số dẫn xuất (PUE, ...) rồi phát ra một "snapshot".

const { EventEmitter } = require('events');
const { FC, toSigned16 } = require('./modbus');

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function decodeDevice(device, registers) {
  const out = {};
  for (const p of device.points) {
    const raw = registers[p.offset];
    if (raw === undefined) continue;
    const v = (p.signed ? toSigned16(raw) : raw) / (p.scale || 1);
    out[`${device.id}.${p.key}`] = round(v);
  }
  return out;
}

function derive(devices, values) {
  const pick = (type, key) =>
    devices.filter(d => d.type === type).map(d => values[`${d.id}.${key}`]).filter(v => typeof v === 'number');
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const out = {};

  const it = pick('power_meter', 'it_kw')[0];
  const facility = pick('power_meter', 'facility_kw')[0];
  if (it > 0 && facility > 0) out['site.pue'] = round(facility / it);

  const cooling = [...pick('crah', 'power_kw'), ...pick('chiller', 'power_kw')];
  if (cooling.length) out['site.cooling_kw'] = round(sum(cooling), 1);

  const inlets = pick('rack_sensor', 'temp');
  if (inlets.length) {
    out['site.inlet_avg'] = round(sum(inlets) / inlets.length, 1);
    out['site.inlet_max'] = round(Math.max(...inlets), 1);
  }
  return out;
}

class Collector extends EventEmitter {
  constructor({ client, devices, intervalMs = 2000 }) {
    super();
    this.client = client;
    this.devices = devices;
    this.intervalMs = intervalMs;
    this.status = Object.fromEntries(
      devices.map(d => [d.id, { status: 'unknown', lastSeen: null, error: null, failures: 0 }])
    );
    this.busy = false;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async readDevice(d) {
    const fc = d.fc || FC.READ_INPUT_REGISTERS;
    return fc === FC.READ_HOLDING_REGISTERS
      ? this.client.readHoldingRegisters(d.unit, d.start || 0, d.count)
      : this.client.readInputRegisters(d.unit, d.start || 0, d.count);
  }

  async tick() {
    if (this.busy) return null; // không chồng lượt đọc khi thiết bị phản hồi chậm
    this.busy = true;
    const ts = Date.now();
    const values = {};
    await Promise.all(
      this.devices.map(async d => {
        const st = this.status[d.id];
        try {
          Object.assign(values, decodeDevice(d, await this.readDevice(d)));
          Object.assign(st, { status: 'online', lastSeen: ts, error: null, failures: 0 });
        } catch (e) {
          Object.assign(st, { status: 'offline', error: e.message, failures: st.failures + 1 });
        }
      })
    );
    Object.assign(values, derive(this.devices, values));
    const snapshot = { ts, values, devices: JSON.parse(JSON.stringify(this.status)) };
    this.busy = false;
    this.emit('snapshot', snapshot);
    return snapshot;
  }
}

module.exports = { Collector, decodeDevice, derive };

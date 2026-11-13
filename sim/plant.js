'use strict';
// Mô hình vật lý đơn giản của một phòng máy, gồm hai miền liên kết với nhau:
// - Làm mát: tải IT sinh nhiệt, 2 CRAH + 1 chiller lấy nhiệt ra, bộ PI điều tốc quạt.
// - Điện: điện lưới / máy phát -> ATS -> tủ MSB -> UPS -> PDU A/B -> rack; CRAH, chiller lấy điện sau ATS
//   (không qua UPS), nên khi mất nguồn hoàn toàn thì làm mát dừng trong lúc IT vẫn chạy bằng pin.
// Bộ PI và logic ATS mô phỏng phần "lõi điều khiển" mà thực tế là hệ thống mua của hãng.
// BMS demo chỉ đọc kết quả qua Modbus, không can thiệp.

const FAULTS = Object.freeze({
  crah1_fail: { vi: 'CRAH-1 hỏng (quạt dừng)', ja: 'CRAH-1 故障（ファン停止）' },
  crah2_fail: { vi: 'CRAH-2 hỏng (quạt dừng)', ja: 'CRAH-2 故障（ファン停止）' },
  chiller_fail: { vi: 'Chiller-1 trip máy nén', ja: 'Chiller-1 圧縮機トリップ' },
  leak_zone2: { vi: 'Rò rỉ nước tại vùng 2', ja: 'ゾーン2で漏水' },
  rack4_sensor_offline: { vi: 'Cảm biến Rack R4 mất kết nối', ja: 'ラック R4 センサー通信断' },
  it_surge: { vi: 'Tải IT tăng đột biến (+60 kW)', ja: 'IT負荷の急増（+60 kW）' },
  utility_outage: { vi: 'Mất điện lưới', ja: '商用電源喪失' },
  gen_fail_start: { vi: 'Máy phát không khởi động', ja: '発電機起動失敗' },
  ups_fail: { vi: 'UPS lỗi, chuyển bypass', ja: 'UPS 故障（バイパス切替）' },
  pdu_a_fail: { vi: 'PDU-A mất nguồn đầu vào', ja: 'PDU-A 入力電源喪失' },
  thd_high: { vi: 'Sóng hài điện áp cao (THD 9%)', ja: '電圧高調波の増大（THD 9%）' },
});
const FAULT_DOMAIN = Object.freeze({
  crah1_fail: 'cooling', crah2_fail: 'cooling', chiller_fail: 'cooling', leak_zone2: 'cooling',
  rack4_sensor_offline: 'cooling', it_surge: 'power', utility_outage: 'power', gen_fail_start: 'power',
  ups_fail: 'power', pdu_a_fail: 'power', thd_high: 'power',
});

// Bản đồ Modbus unit id (giống "tài liệu thanh ghi" của nhà sản xuất thiết bị)
const UNIT = Object.freeze({
  CRAH: [1, 2], CHILLER: 10, RACKS: [21, 22, 23, 24, 25, 26], LEAK: 30,
  MSB: 41, UPS: 42, GEN: 43, ATS: 44, PDU: [45, 46],
});
const SRC = Object.freeze({ UTIL: 0, GEN: 1, NONE: 2 }); // nguồn sau ATS
const GEN = Object.freeze({ STANDBY: 0, STARTING: 1, RUNNING: 2, FAULT: 3 });
const UPS = Object.freeze({ ONLINE: 0, BATTERY: 1, BYPASS: 2 });

const SETPOINT = 24; // °C, nhiệt độ cold aisle mục tiêu
const CRAH_CAPACITY_KW = 100; // ở 100% quạt, nước lạnh 7°C
const THERMAL_MASS = 600; // kW·s/°C
const UPS_RATED_KW = 250;
const BATTERY_KWH = 40; // ~19 phút ở tải 127 kW
const GEN_START_S = 10; // thời gian máy phát khởi động tới lúc nhận tải
const RETRANSFER_S = 15; // điện lưới phải ổn định bấy lâu mới chuyển về
const GEN_COOLDOWN_S = 30; // máy phát chạy không tải sau khi chuyển về lưới
const CHILLER_RESTART_S = 30; // chiller chờ khởi động lại sau khi có điện
// Tỷ lệ tải IT theo rack R1–R6, chia theo tổng công suất định mức của máy chủ mẫu trong config/dcim.json,
// để số đo trên PDU khớp với hồ sơ DCIM (R4 gần hết ngân sách điện, R6 gần trống). Tổng tải IT không đổi.
const rackWeights = dcim => {
  const kw = dcim.racks.map(r => r.devices.reduce((s, d) => s + dcim.deviceTypes[d.type].ratedKw, 0));
  const total = kw.reduce((s, x) => s + x, 0);
  return kw.map(x => x / total);
};
const RACK_WEIGHTS = rackWeights(require('../config/dcim.json'));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const enc = (v, scale = 1) => Math.round(v * scale) & 0xffff;

class Plant {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.t = 0;
    this.room = 23.5;
    this.integral = 0;
    this.faults = new Set();
    this.itKw = 120;
    this.facilityKw = 0;
    this.crah = [0, 1].map(() => ({ fan: 60, status: 1, supply: 17, ret: 34, kw: 0, removedKw: 0 }));
    this.chiller = { status: 1, chwSupply: 7, chwReturn: 12, kw: 0, load: 0, restart: 0 };
    this.rackOffsets = [-0.6, -0.1, 0.4, 1.1, 0.3, -0.3]; // R4 là điểm nóng
    this.racks = this.rackOffsets.map(() => ({ temp: 23.5, humidity: 45 }));
    this.rackKw = RACK_WEIGHTS.map(w => 120 * w);
    this.power = {
      utilOk: true,
      utilStable: 999,
      ats: { source: SRC.UTIL, transfers: 0 },
      gen: { status: GEN.STANDBY, timer: 0, cooldown: 0, kw: 0, fuel: 85, runHours: 1234.5 },
      ups: { mode: UPS.ONLINE, battery: 100, outKw: 120, loadPct: 48, runtime: 19, charging: false },
      msb: { v: 400, a: 0, kw: 0, pf: 0.95, hz: 50, thd: 2.5, kwh: 1250000 },
      pdu: [0, 1].map(() => ({ status: 0, total: 60, racks: RACK_WEIGHTS.map(w => 60 * w) })),
    };
  }

  noise(amp) {
    return (this.random() * 2 - 1) * amp;
  }

  setFault(name, active) {
    if (!(name in FAULTS)) throw new Error(`Unknown fault: ${name}`);
    if (active) this.faults.add(name);
    else this.faults.delete(name);
  }

  // Điện lưới, máy phát, ATS. Trả về nguồn đang cấp sau ATS.
  _stepSources(dt) {
    const p = this.power;
    const f = this.faults;
    const g = p.gen;
    const ats = p.ats;
    p.utilOk = !f.has('utility_outage');
    p.utilStable = p.utilOk ? p.utilStable + dt : 0;

    const wantGen = !p.utilOk || ats.source === SRC.GEN || g.cooldown > 0;
    if (!wantGen) {
      g.status = GEN.STANDBY;
    } else if (g.status !== GEN.RUNNING) {
      if (f.has('gen_fail_start')) {
        g.status = GEN.FAULT;
      } else {
        if (g.status !== GEN.STARTING) {
          g.status = GEN.STARTING;
          g.timer = 0;
        }
        g.timer += dt;
        if (g.timer >= GEN_START_S) g.status = GEN.RUNNING;
      }
    }
    if (g.status === GEN.RUNNING) {
      g.fuel = Math.max(0, g.fuel - 0.02 * dt);
      g.runHours += dt / 3600;
    }

    let next;
    if (p.utilOk && (ats.source !== SRC.GEN || p.utilStable >= RETRANSFER_S || g.status !== GEN.RUNNING)) next = SRC.UTIL;
    else if (g.status === GEN.RUNNING) next = SRC.GEN;
    else next = SRC.NONE;
    if (next !== ats.source) {
      if (next !== SRC.NONE) ats.transfers += 1;
      if (ats.source === SRC.GEN && next === SRC.UTIL) g.cooldown = GEN_COOLDOWN_S;
      ats.source = next;
    }
    if (g.cooldown > 0 && ats.source === SRC.UTIL) g.cooldown = Math.max(0, g.cooldown - dt);
    return ats.source;
  }

  // UPS: trả về công suất IT thực sự được cấp (0 nếu hết pin hoặc bypass mà không có nguồn)
  _stepUps(dt, demand, src) {
    const u = this.power.ups;
    const srcOk = src !== SRC.NONE;
    let delivered;
    if (this.faults.has('ups_fail')) {
      u.mode = UPS.BYPASS;
      delivered = srcOk ? demand : 0;
    } else if (srcOk) {
      u.mode = UPS.ONLINE;
      delivered = demand;
      u.battery = Math.min(100, u.battery + 0.2 * dt);
    } else {
      u.mode = UPS.BATTERY;
      delivered = u.battery > 0 ? demand : 0;
      u.battery = Math.max(0, u.battery - ((delivered * dt) / 3600 / BATTERY_KWH) * 100);
    }
    u.outKw = delivered;
    u.loadPct = (delivered / UPS_RATED_KW) * 100;
    const availKwh = u.mode === UPS.BYPASS ? 0 : (u.battery / 100) * BATTERY_KWH;
    u.runtime = delivered > 1 ? Math.min(999, (availKwh / delivered) * 60) : 999;
    u.charging = srcOk && u.mode === UPS.ONLINE && u.battery < 100;
    return delivered;
  }

  _stepMeters(dt, src) {
    const p = this.power;
    const m = p.msb;
    const srcOk = src !== SRC.NONE;
    const upsLoss = p.ups.outKw * 0.06 + (p.ups.charging ? 8 : 0);
    const coolingKw = this.crah.reduce((s, c) => s + c.kw, 0) + this.chiller.kw;
    this.facilityKw = srcOk ? p.ups.outKw + upsLoss + coolingKw + 6 /* bơm, tháp, chiếu sáng */ + this.noise(0.3) : 0;
    m.kw = this.facilityKw;
    m.pf = srcOk ? 0.95 + this.noise(0.005) : 0;
    m.v = srcOk ? (src === SRC.UTIL ? 400 : 398) + this.noise(1.5) : 0;
    m.a = srcOk ? (m.kw * 1000) / (Math.sqrt(3) * m.v * m.pf) : 0;
    m.hz = srcOk ? 50 + this.noise(src === SRC.UTIL ? 0.02 : 0.15) : 0;
    m.thd = srcOk ? (this.faults.has('thd_high') ? 9 : src === SRC.GEN ? 4 : 2.5) + this.noise(0.2) : 0;
    m.kwh += (m.kw * dt) / 3600;
    p.gen.kw = src === SRC.GEN ? m.kw : 0;

    // Mỗi rack cấp nguồn kép, chia đều cho PDU-A và PDU-B; mất A thì B gánh toàn bộ
    this.rackKw = RACK_WEIGHTS.map(w => this.itKw * w);
    const aDown = this.faults.has('pdu_a_fail');
    const [a, b] = p.pdu;
    a.status = aDown ? 1 : 0;
    b.status = 0;
    a.racks = this.rackKw.map(kw => (aDown ? 0 : kw / 2));
    b.racks = this.rackKw.map(kw => (aDown ? kw : kw / 2));
    a.total = a.racks.reduce((s, x) => s + x, 0);
    b.total = b.racks.reduce((s, x) => s + x, 0);
  }

  step(dt) {
    const f = this.faults;
    this.t += dt;

    // Tải IT dao động theo chu kỳ 10 phút (rút gọn một ngày làm việc cho demo)
    const demand = Math.max(0, 120 + 15 * Math.sin((2 * Math.PI * this.t) / 600) + (f.has('it_surge') ? 60 : 0) + this.noise(1.5));
    const src = this._stepSources(dt);
    const mechPowered = src !== SRC.NONE;
    this.itKw = this._stepUps(dt, demand, src);

    // Chiller: trip -> lỗi; mất điện -> dừng, có điện lại thì chờ khởi động lại
    const ch = this.chiller;
    if (f.has('chiller_fail')) {
      ch.status = 2;
    } else if (!mechPowered) {
      ch.status = 0;
      ch.restart = CHILLER_RESTART_S;
    } else if (ch.restart > 0) {
      ch.restart = Math.max(0, ch.restart - dt);
      ch.status = 0;
    } else {
      ch.status = 1;
    }
    const chwTarget = ch.status === 1 ? 7 : 20;
    ch.chwSupply += (chwTarget - ch.chwSupply) * Math.min(1, 0.03 * dt);
    const coilEff = clamp((20 - ch.chwSupply) / 13, 0, 1);

    // Bộ điều khiển PI cục bộ: điều tốc quạt CRAH để giữ nhiệt độ phòng
    const err = this.room - SETPOINT;
    this.integral = clamp(this.integral + err * dt, -40, 40);
    const fanTarget = clamp(55 + 20 * err + this.integral, 30, 100);

    let removed = 0;
    this.crah.forEach((c, i) => {
      const failed = f.has(`crah${i + 1}_fail`);
      c.status = failed ? 2 : mechPowered ? 1 : 0;
      const rate = 8 * dt;
      c.fan = clamp(c.fan + clamp((c.status === 1 ? fanTarget : 0) - c.fan, -rate, rate), 0, 100);
      c.removedKw = CRAH_CAPACITY_KW * (c.fan / 100) * coilEff;
      c.kw = c.fan > 0.5 ? 0.4 + 6.5 * (c.fan / 100) ** 3 : 0;
      c.supply = c.status === 1 ? ch.chwSupply + 9 + this.noise(0.1) : this.room + 2;
      c.ret = this.room + 11 + this.noise(0.15);
      removed += c.removedKw;
    });

    this.room = clamp(this.room + ((this.itKw - removed) / THERMAL_MASS) * dt, 15, 45);

    ch.load = clamp((removed / 250) * 100, 0, 100);
    ch.kw = ch.status === 1 ? removed / 4.5 : mechPowered ? 1.5 : 0;
    ch.chwReturn = ch.chwSupply + removed / 24;

    this.racks.forEach((r, i) => {
      let extra = 0;
      if (f.has('crah1_fail')) extra += i < 3 ? 1.5 : 0.5;
      if (f.has('crah2_fail')) extra += i >= 3 ? 1.5 : 0.5;
      r.temp = this.room + this.rackOffsets[i] + extra + this.noise(0.15);
      r.humidity = 45 + 4 * Math.sin((2 * Math.PI * this.t) / 900 + i) + this.noise(0.5);
    });

    this._stepMeters(dt, src);
  }

  // Trả về mảng thanh ghi (uint16) của một thiết bị, hoặc null nếu thiết bị không phản hồi.
  registers(unit) {
    const p = this.power;
    const ci = UNIT.CRAH.indexOf(unit);
    if (ci >= 0) {
      const c = this.crah[ci];
      return [enc(c.supply, 10), enc(c.ret, 10), enc(c.fan), c.status, enc(c.kw, 10)];
    }
    if (unit === UNIT.CHILLER) {
      const c = this.chiller;
      return [enc(c.chwSupply, 10), enc(c.chwReturn, 10), c.status, enc(c.kw, 10), enc(c.load)];
    }
    const ri = UNIT.RACKS.indexOf(unit);
    if (ri >= 0) {
      if (ri === 3 && this.faults.has('rack4_sensor_offline')) return null;
      const r = this.racks[ri];
      return [enc(r.temp, 10), enc(r.humidity, 10)];
    }
    if (unit === UNIT.LEAK) {
      const leak = this.faults.has('leak_zone2');
      return [leak ? 1 : 0, leak ? 2 : 0];
    }
    if (unit === UNIT.MSB) {
      const m = p.msb;
      const kwh = Math.floor(m.kwh) >>> 0; // uint32: 2 thanh ghi, word cao trước
      return [enc(m.v), enc(m.a), enc(m.kw, 10), enc(m.pf, 100), enc(m.hz, 100), enc(m.thd, 10), (kwh >>> 16) & 0xffff, kwh & 0xffff];
    }
    if (unit === UNIT.UPS) {
      const u = p.ups;
      return [u.mode, enc(u.loadPct), enc(u.outKw, 10), enc(u.battery), enc(u.runtime)];
    }
    if (unit === UNIT.GEN) {
      const g = p.gen;
      return [g.status, enc(g.kw, 10), enc(g.fuel), enc(g.runHours, 10)];
    }
    if (unit === UNIT.ATS) return [p.ats.source, p.utilOk ? 1 : 0, p.ats.transfers & 0xffff];
    const pi = UNIT.PDU.indexOf(unit);
    if (pi >= 0) {
      const d = p.pdu[pi];
      return [d.status, enc(d.total, 10), ...d.racks.map(x => enc(x, 10))];
    }
    return null;
  }
}

module.exports = { Plant, FAULTS, FAULT_DOMAIN, UNIT, SETPOINT, SRC, GEN, UPS, RACK_WEIGHTS, rackWeights };

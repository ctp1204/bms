'use strict';
// Mô hình vật lý đơn giản của một phòng máy: tải IT sinh nhiệt, 2 CRAH + 1 chiller lấy nhiệt ra.
// Bộ điều khiển PI bên trong mô phỏng phần "lõi điều khiển" mà trong thực tế là BMS mua của hãng
// (DDC/PLC). BMS demo chỉ đọc kết quả qua Modbus, không can thiệp vào vòng điều khiển này.

const FAULTS = Object.freeze({
  crah1_fail: { vi: 'CRAH-1 hỏng (quạt dừng)', ja: 'CRAH-1 故障（ファン停止）' },
  crah2_fail: { vi: 'CRAH-2 hỏng (quạt dừng)', ja: 'CRAH-2 故障（ファン停止）' },
  chiller_fail: { vi: 'Chiller-1 trip máy nén', ja: 'Chiller-1 圧縮機トリップ' },
  leak_zone2: { vi: 'Rò rỉ nước tại vùng 2', ja: 'ゾーン2で漏水' },
  rack4_sensor_offline: { vi: 'Cảm biến Rack R4 mất kết nối', ja: 'ラック R4 センサー通信断' },
  it_surge: { vi: 'Tải IT tăng đột biến (+60 kW)', ja: 'IT負荷の急増（+60 kW）' },
});

// Bản đồ Modbus unit id (giống "tài liệu thanh ghi" của nhà sản xuất thiết bị)
const UNIT = Object.freeze({ CRAH: [1, 2], CHILLER: 10, RACKS: [21, 22, 23, 24, 25, 26], LEAK: 30, METER: 40 });

const SETPOINT = 24; // °C, nhiệt độ cold aisle mục tiêu
const CRAH_CAPACITY_KW = 100; // ở 100% quạt, nước lạnh 7°C
const THERMAL_MASS = 600; // kW·s/°C

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
    this.chiller = { status: 1, chwSupply: 7, chwReturn: 12, kw: 0, load: 0 };
    this.rackOffsets = [-0.6, -0.1, 0.4, 1.1, 0.3, -0.3]; // R4 là điểm nóng
    this.racks = this.rackOffsets.map(() => ({ temp: 23.5, humidity: 45 }));
  }

  noise(amp) {
    return (this.random() * 2 - 1) * amp;
  }

  setFault(name, active) {
    if (!(name in FAULTS)) throw new Error(`Unknown fault: ${name}`);
    if (active) this.faults.add(name);
    else this.faults.delete(name);
  }

  step(dt) {
    const f = this.faults;
    this.t += dt;

    // Tải IT dao động theo chu kỳ 10 phút (rút gọn một ngày làm việc cho demo)
    this.itKw = 120 + 15 * Math.sin((2 * Math.PI * this.t) / 600) + (f.has('it_surge') ? 60 : 0) + this.noise(1.5);

    // Chiller: khi trip, nước lạnh ấm dần lên, dàn lạnh CRAH mất hiệu quả
    const ch = this.chiller;
    ch.status = f.has('chiller_fail') ? 2 : 1;
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
      c.status = failed ? 2 : 1;
      const rate = 8 * dt;
      c.fan = clamp(c.fan + clamp((failed ? 0 : fanTarget) - c.fan, -rate, rate), 0, 100);
      c.removedKw = CRAH_CAPACITY_KW * (c.fan / 100) * coilEff;
      c.kw = c.fan > 0.5 ? 0.4 + 6.5 * (c.fan / 100) ** 3 : 0;
      c.supply = failed ? this.room + 2 : ch.chwSupply + 9 + this.noise(0.1);
      c.ret = this.room + 11 + this.noise(0.15);
      removed += c.removedKw;
    });

    this.room = clamp(this.room + ((this.itKw - removed) / THERMAL_MASS) * dt, 15, 45);

    ch.load = clamp((removed / 250) * 100, 0, 100);
    ch.kw = ch.status === 1 ? removed / 4.5 : 1.5;
    ch.chwReturn = ch.chwSupply + removed / 24;

    this.racks.forEach((r, i) => {
      let extra = 0;
      if (f.has('crah1_fail')) extra += i < 3 ? 1.5 : 0.5;
      if (f.has('crah2_fail')) extra += i >= 3 ? 1.5 : 0.5;
      r.temp = this.room + this.rackOffsets[i] + extra + this.noise(0.15);
      r.humidity = 45 + 4 * Math.sin((2 * Math.PI * this.t) / 900 + i) + this.noise(0.5);
    });

    const coolingKw = this.crah.reduce((s, c) => s + c.kw, 0) + ch.kw;
    this.facilityKw = this.itKw + coolingKw + 4 /* bơm, tháp */ + 2 /* chiếu sáng */ + this.itKw * 0.06 /* tổn hao UPS */ + this.noise(0.3);
  }

  // Trả về mảng thanh ghi (uint16) của một thiết bị, hoặc null nếu thiết bị không phản hồi.
  registers(unit) {
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
    if (unit === UNIT.METER) return [enc(this.itKw, 10), enc(this.facilityKw, 10)];
    return null;
  }
}

module.exports = { Plant, FAULTS, UNIT, SETPOINT };

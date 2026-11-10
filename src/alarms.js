'use strict';
// Bộ xử lý cảnh báo theo tinh thần ISA-18.2 (rút gọn):
// - delaySec: điều kiện phải kéo dài đủ lâu mới báo (chống báo giả do nhiễu)
// - deadband: phải về dưới ngưỡng một khoảng mới xóa (chống "nhấp nháy" quanh ngưỡng)
// - Cảnh báo chỉ biến mất khỏi danh sách khi đã hết VÀ đã được xác nhận (ack).

const { EventEmitter } = require('events');
const { loc, formatNumber } = require('./locale');

const globToRegExp = glob =>
  new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')}$`);

function isTripped(op, v, threshold) {
  if (op === '>') return v > threshold;
  if (op === '<') return v < threshold;
  if (op === '==') return v === threshold;
  throw new Error(`Unsupported op: ${op}`);
}

function isCleared(op, v, threshold, deadband = 0) {
  if (op === '>') return v <= threshold - deadband;
  if (op === '<') return v >= threshold + deadband;
  return v !== threshold;
}

class AlarmEngine extends EventEmitter {
  // pointMeta: { "rack1.temp": { name, device, uom } }, deviceNames: { rack1: "Rack R1" }
  // name, deviceNames và rule.message có thể là chuỗi hoặc { vi, ja }. langs[0] là ngôn ngữ mặc định.
  constructor(rules, { pointMeta = {}, deviceNames = {}, langs = ['vi'] } = {}) {
    super();
    this.rules = rules.map(r => (r.point ? { ...r, re: globToRegExp(r.point) } : { ...r }));
    this.pointMeta = pointMeta;
    this.deviceNames = deviceNames;
    this.langs = langs;
    this.instances = new Map(); // key -> { pendingSince, alarm }
    this.seq = 0;
  }

  // Trả về { vi: "...", ja: "..." } cho mọi ngôn ngữ trong this.langs
  format(rule, deviceId, point, value) {
    const meta = this.pointMeta[point] || {};
    const out = {};
    for (const lang of this.langs) {
      out[lang] = String(loc(rule.message, lang))
        .replace('{device}', loc(this.deviceNames[deviceId], lang) || deviceId || '')
        .replace('{name}', loc(meta.name, lang) || point || '')
        .replace('{value}', typeof value === 'number' ? formatNumber(value, lang) : '')
        .replace('{uom}', meta.uom || '');
    }
    return out;
  }

  _setMessages(alarm, rule, deviceId, point, value) {
    alarm.messages = this.format(rule, deviceId, point, value);
    alarm.message = alarm.messages[this.langs[0]];
  }

  // Một điều kiện (rule + điểm) đánh giá trong một chu kỳ
  _evalOne(key, rule, ctx) {
    const { tripped, cleared, ts, deviceId, point, value } = ctx;
    let inst = this.instances.get(key);
    if (!inst) {
      inst = { pendingSince: null, alarm: null };
      this.instances.set(key, inst);
    }
    const a = inst.alarm;
    const active = a && !a.clearedAt;

    if (tripped) {
      if (active) {
        a.value = value;
        this._setMessages(a, rule, deviceId, point, value);
        return;
      }
      if (inst.pendingSince === null) inst.pendingSince = ts;
      if (ts - inst.pendingSince >= (rule.delaySec || 0) * 1000) {
        if (a) this._retire(key, a); // lần trước đã hết nhưng chưa ack: thay bằng lần mới
        inst.alarm = {
          id: ++this.seq,
          key,
          ruleId: rule.id,
          deviceId,
          point: point || null,
          severity: rule.severity,
          message: null,
          messages: null,
          value,
          threshold: rule.value,
          raisedAt: ts,
          clearedAt: null,
          ackedAt: null,
          ackedBy: null,
        };
        this._setMessages(inst.alarm, rule, deviceId, point, value);
        inst.pendingSince = null;
        this.emit('event', { ts, type: 'raised', alarm: { ...inst.alarm } });
      }
      return;
    }

    inst.pendingSince = null;
    if (active && cleared) {
      a.clearedAt = ts;
      a.value = value;
      this.emit('event', { ts, type: 'cleared', alarm: { ...a } });
      if (a.ackedAt) this._retire(key, a);
    }
  }

  _retire(key, alarm) {
    const inst = this.instances.get(key);
    if (inst && inst.alarm === alarm) inst.alarm = null;
  }

  evaluate(snapshot) {
    const { ts, values, devices } = snapshot;
    for (const rule of this.rules) {
      if (rule.type === 'comm') {
        for (const [deviceId, st] of Object.entries(devices || {})) {
          const down = st.status === 'offline';
          this._evalOne(`${rule.id}:${deviceId}`, rule, { tripped: down, cleared: !down, ts, deviceId, value: null });
        }
        continue;
      }
      for (const [point, value] of Object.entries(values)) {
        if (!rule.re.test(point) || typeof value !== 'number') continue;
        this._evalOne(`${rule.id}:${point}`, rule, {
          tripped: isTripped(rule.op, value, rule.value),
          cleared: isCleared(rule.op, value, rule.value, rule.deadband),
          ts,
          deviceId: point.split('.')[0],
          point,
          value,
        });
      }
    }
  }

  ack(id, user = 'operator', ts = Date.now()) {
    for (const [key, inst] of this.instances) {
      const a = inst.alarm;
      if (!a || a.id !== id) continue;
      if (a.ackedAt) return a;
      a.ackedAt = ts;
      a.ackedBy = user;
      this.emit('event', { ts, type: 'acked', alarm: { ...a } });
      if (a.clearedAt) this._retire(key, a);
      return a;
    }
    return null;
  }

  // suppressedBy: ẩn cảnh báo mức thấp khi cảnh báo mức cao hơn trên CÙNG điểm đang hoạt động
  // (vd. "rack > 27°C" bị ẩn khi "rack > 32°C" đang báo) để giảm nhiễu cho người trực.
  _isSuppressed(a) {
    const rule = this.rules.find(r => r.id === a.ruleId);
    if (!rule || !rule.suppressedBy || a.clearedAt) return false;
    const other = this.instances.get(`${rule.suppressedBy}:${a.point}`);
    return Boolean(other && other.alarm && !other.alarm.clearedAt);
  }

  list() {
    const order = { critical: 0, warning: 1, info: 2 };
    return [...this.instances.values()]
      .map(i => i.alarm)
      .filter(a => a && !this._isSuppressed(a))
      .sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9) || y.raisedAt - x.raisedAt)
      .map(a => ({ ...a }));
  }
}

module.exports = { AlarmEngine, globToRegExp, isTripped, isCleared };

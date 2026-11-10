'use strict';
// Lưu lịch sử trong bộ nhớ (ring buffer). Đủ cho demo; hệ thống thật dùng CSDL chuỗi thời gian
// (InfluxDB, TimescaleDB, ...) để giữ dữ liệu nhiều năm và không mất khi khởi động lại.

class History {
  constructor(maxSamples) {
    this.maxSamples = maxSamples;
    this.samples = [];
  }

  push(ts, values) {
    this.samples.push({ ts, values });
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
  }

  // Trả về [[ts, value], ...], gộp trung bình theo bucket để không quá maxPoints điểm
  query(point, sinceTs, maxPoints = 400) {
    const rows = [];
    for (const s of this.samples) {
      if (s.ts < sinceTs) continue;
      const v = s.values[point];
      if (typeof v === 'number') rows.push([s.ts, v]);
    }
    if (rows.length <= maxPoints) return rows;
    const size = Math.ceil(rows.length / maxPoints);
    const out = [];
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const avg = chunk.reduce((a, r) => a + r[1], 0) / chunk.length;
      out.push([chunk[chunk.length - 1][0], Math.round(avg * 100) / 100]);
    }
    return out;
  }
}

module.exports = { History };

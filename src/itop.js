'use strict';
// Client tối thiểu cho REST/JSON API của iTop (webservices/rest.php, version 1.3).
// Chỉ dùng http/https có sẵn của Node, không thêm thư viện.

const http = require('http');
const https = require('https');

class ItopError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ItopError';
    this.code = code; // mã lỗi của iTop (khác 0), hoặc 'HTTP_<status>' / 'NETWORK'
  }
}

// Bọc giá trị vào chuỗi OQL, thoát \ và ' bằng dấu gạch chéo ngược.
const oqlString = v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

class ItopClient {
  constructor({ url, user, password, timeoutMs = 10000 }) {
    if (!url || !user || !password) throw new Error('ItopClient cần url, user và password');
    this.endpoint = new URL('webservices/rest.php?version=1.3', url.endsWith('/') ? url : `${url}/`);
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  call(payload) {
    const body = new URLSearchParams({ auth_user: this.user, auth_pwd: this.password, json_data: JSON.stringify(payload) }).toString();
    const lib = this.endpoint.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          // iTop sau đường hầm ngrok miễn phí: bỏ qua trang cảnh báo dành cho trình duyệt. Vô hại với nơi khác.
          'ngrok-skip-browser-warning': '1',
        },
        timeout: this.timeoutMs,
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new ItopError(`iTop trả HTTP ${res.statusCode}`, `HTTP_${res.statusCode}`));
          let json;
          try { json = JSON.parse(data); } catch (e) { return reject(new ItopError('iTop trả về dữ liệu không phải JSON', 'BAD_JSON')); }
          if (json.code !== 0) return reject(new ItopError(json.message || `iTop lỗi ${json.code}`, json.code));
          return resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new ItopError(`iTop không trả lời sau ${this.timeoutMs} ms`, 'TIMEOUT')));
      req.on('error', e => reject(e instanceof ItopError ? e : new ItopError(e.message, 'NETWORK')));
      req.end(body);
    });
  }

  // Trả về mảng [{ key, class, fields }]
  async get(cls, key, outputFields = '*') {
    const r = await this.call({ operation: 'core/get', class: cls, key, output_fields: outputFields });
    return Object.values(r.objects || {}).map(o => ({ key: Number(o.key), class: o.class, fields: o.fields }));
  }

  async create(cls, fields, { comment = 'bms-itsm', outputFields = 'id' } = {}) {
    const r = await this.call({ operation: 'core/create', comment, class: cls, fields, output_fields: outputFields });
    const [o] = Object.values(r.objects);
    return { key: Number(o.key), class: o.class, fields: o.fields };
  }

  async update(cls, key, fields, { comment = 'bms-itsm', outputFields = 'id' } = {}) {
    const r = await this.call({ operation: 'core/update', comment, class: cls, key, fields, output_fields: outputFields });
    const [o] = Object.values(r.objects);
    return { key: Number(o.key), class: o.class, fields: o.fields };
  }
}

module.exports = { ItopClient, ItopError, oqlString };

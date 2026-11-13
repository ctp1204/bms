'use strict';
// Client tối thiểu cho REST API của NetBox (4.x, token v2). Chỉ dùng http/https có sẵn của Node.
// Không có hàm xóa: tài khoản bms-dcim cũng không có quyền xóa.

const http = require('http');
const https = require('https');

class NetboxError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'NetboxError';
    this.code = code; // 'HTTP_<status>', 'NETWORK', 'TIMEOUT', 'BAD_JSON'
    this.details = details; // body lỗi NetBox trả về (thường chỉ rõ trường nào sai)
  }
}

class NetboxClient {
  // token: chuỗi đầy đủ dạng nbt_<key>.<token>
  constructor({ url, token, timeoutMs = 15000, pageSize = 1000 }) {
    if (!url || !token) throw new Error('NetboxClient cần url và token');
    this.base = new URL('api/', url.endsWith('/') ? url : `${url}/`);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.pageSize = pageSize;
  }

  request(method, pathOrUrl, body) {
    const target = /^https?:/.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(pathOrUrl.replace(/^\//, ''), this.base);
    const lib = target.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(target, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          'ngrok-skip-browser-warning': '1',
        },
        timeout: this.timeoutMs,
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => {
          let json = null;
          if (text) {
            try { json = JSON.parse(text); } catch (e) {
              return reject(new NetboxError(`NetBox trả về dữ liệu không phải JSON (HTTP ${res.statusCode})`, 'BAD_JSON'));
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const detail = json && (json.detail || JSON.stringify(json));
          return reject(new NetboxError(`NetBox trả HTTP ${res.statusCode} cho ${method} ${target.pathname}${detail ? `: ${detail}` : ''}`,
            `HTTP_${res.statusCode}`, json));
        });
      });
      req.on('timeout', () => req.destroy(new NetboxError(`NetBox không trả lời sau ${this.timeoutMs} ms`, 'TIMEOUT')));
      req.on('error', e => reject(e instanceof NetboxError ? e : new NetboxError(e.message, 'NETWORK')));
      req.end(data);
    });
  }

  // Lấy mọi trang. endpoint ví dụ 'dcim/racks/', query là object bộ lọc.
  async list(endpoint, query = {}) {
    const qs = new URLSearchParams({ ...query, limit: String(this.pageSize) });
    let next = `${endpoint}?${qs}`;
    const out = [];
    while (next) {
      const page = await this.request('GET', next);
      out.push(...page.results);
      next = page.next;
    }
    return out;
  }

  create(endpoint, fields) { return this.request('POST', endpoint, fields); }

  update(endpoint, id, fields) { return this.request('PATCH', `${endpoint}${id}/`, fields); }
}

module.exports = { NetboxClient, NetboxError };

'use strict';
// BMS demo: thu thập (Modbus, chỉ đọc) -> lịch sử + cảnh báo -> HTTP API + SSE -> dashboard web.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ModbusTcpClient } = require('./modbus');
const { Collector } = require('./collector');
const { AlarmEngine } = require('./alarms');
const { History } = require('./history');
const { LANGS } = require('./locale');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const SIM_CONTROL_PORT = Number(process.env.SIM_CONTROL_PORT || 5021);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/devices.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/alarms.json'), 'utf8'));
if (process.env.MODBUS_HOST) cfg.modbus.host = process.env.MODBUS_HOST;
if (process.env.MODBUS_PORT) cfg.modbus.port = Number(process.env.MODBUS_PORT);

const pointMeta = {};
for (const d of cfg.devices) {
  for (const p of d.points) pointMeta[`${d.id}.${p.key}`] = { name: p.name, uom: p.uom || '', device: d.id, enum: p.enum };
}
for (const p of cfg.derived) pointMeta[p.id] = { name: p.name, uom: p.uom, device: 'site' };
const deviceNames = Object.fromEntries(cfg.devices.map(d => [d.id, d.name]));

const client = new ModbusTcpClient(cfg.modbus);
const collector = new Collector({ client, devices: cfg.devices, intervalMs: cfg.pollIntervalMs });
const alarms = new AlarmEngine(rules, { pointMeta, deviceNames, langs: LANGS });
const history = new History(Math.ceil((cfg.historyHours * 3600 * 1000) / cfg.pollIntervalMs));

// Nhật ký sự kiện cảnh báo: ghi nối vào file (phục vụ truy vết) + giữ 500 dòng gần nhất trong bộ nhớ
fs.mkdirSync(DATA, { recursive: true });
const eventLog = fs.createWriteStream(path.join(DATA, 'events.jsonl'), { flags: 'a' });
const recentEvents = [];
alarms.on('event', e => {
  eventLog.write(`${JSON.stringify(e)}\n`);
  recentEvents.push(e);
  if (recentEvents.length > 500) recentEvents.shift();
});

let last = null;
const sseClients = new Set();
collector.on('snapshot', snap => {
  history.push(snap.ts, snap.values);
  alarms.evaluate(snap);
  last = { ...snap, alarms: alarms.list() };
  const msg = `data: ${JSON.stringify(last)}\n\n`;
  for (const res of sseClients) res.write(msg);
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 4096) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    return res.end(data);
  });
  return undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, {
        langs: LANGS,
        site: cfg.site,
        pollIntervalMs: cfg.pollIntervalMs,
        devices: cfg.devices.map(({ id, name, type, unit, position, points }) => ({ id, name, type, unit, position, points })),
        derived: cfg.derived,
        rules: rules.map(({ id, point, op, value, severity, type }) => ({ id, point, op, value, severity, type })),
        simControlPort: SIM_CONTROL_PORT,
      });
    }
    if (req.method === 'GET' && p === '/api/snapshot') return json(res, 200, last || {});
    if (req.method === 'GET' && p === '/api/history') {
      const point = url.searchParams.get('point');
      const minutes = Math.min(Number(url.searchParams.get('minutes')) || 15, cfg.historyHours * 60);
      if (!pointMeta[point]) return json(res, 400, { error: 'Unknown point' });
      return json(res, 200, { point, meta: pointMeta[point], rows: history.query(point, Date.now() - minutes * 60000) });
    }
    if (req.method === 'GET' && p === '/api/alarms') return json(res, 200, alarms.list());
    if (req.method === 'GET' && p === '/api/events') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      return json(res, 200, recentEvents.slice(-limit).reverse());
    }
    const ack = p.match(/^\/api\/alarms\/(\d+)\/ack$/);
    if (req.method === 'POST' && ack) {
      const body = await readBody(req);
      const user = String((body && JSON.parse(body).user) || 'operator').slice(0, 40);
      const a = alarms.ack(Number(ack[1]), user);
      if (!a) return json(res, 404, { error: 'Alarm not found' });
      if (last) last.alarms = alarms.list();
      return json(res, 200, a);
    }
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      if (last) res.write(`data: ${JSON.stringify(last)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return undefined;
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[bms] Cổng ${PORT} đang bị chiếm (có thể một bản demo khác đang chạy). Tắt nó hoặc chạy với PORT=<cổng khác>.`);
  } else {
    console.error(`[bms] ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[bms] Dashboard on http://${HOST}:${PORT}`);
  console.log(`[bms] Polling Modbus ${cfg.modbus.host}:${cfg.modbus.port} every ${cfg.pollIntervalMs} ms (read-only)`);
  collector.start();
});

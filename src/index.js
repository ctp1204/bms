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
const { checkBasicAuth } = require('./auth');
const { ItopClient } = require('./itop');
const { ItsmConnector } = require('./itsm');
const { NetboxClient } = require('./netbox');
const { DcimInventory, computeCapacity, planPlacement } = require('./dcim-capacity');
const { powerImpact, impactLines } = require('./dcim-impact');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const SIM_CONTROL_PORT = Number(process.env.SIM_CONTROL_PORT || 5021);
// SIM_PROXY=1: chế độ deploy một cổng. BMS chuyển tiếp /sim/api/faults sang API sự cố của bộ giả lập
// để bảng "Giả lập sự cố" dùng được qua cùng domain. Chỉ dành cho demo; BMS vẫn không ghi gì xuống thiết bị.
const SIM_PROXY = process.env.SIM_PROXY === '1';
const SIM_HOST = process.env.SIM_HOST || '127.0.0.1';
const AUTH_USER = process.env.BASIC_AUTH_USER || 'demo';
const AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || '';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/devices.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/alarms.json'), 'utf8'));
if (process.env.MODBUS_HOST) cfg.modbus.host = process.env.MODBUS_HOST;
if (process.env.MODBUS_PORT) cfg.modbus.port = Number(process.env.MODBUS_PORT);

const pointMeta = {};
for (const d of cfg.devices) {
  for (const p of d.points) {
    pointMeta[`${d.id}.${p.key}`] = { name: p.name, uom: p.uom || '', device: d.id, enum: p.enum, decimals: p.decimals, domain: d.domain };
  }
}
for (const p of cfg.derived) pointMeta[p.id] = { name: p.name, uom: p.uom, device: 'site', decimals: p.decimals, domain: p.domain };
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

// DCIM: dung lượng rack/PDU. Hồ sơ đọc từ NetBox khi có token (DCIM_API_KEY, DCIM_API_TOKEN, vd. qua
// `npm run start:dcim`), làm mới mỗi phút; không có NetBox (vd. trên Render) thì dùng config/dcim.json.
// DCIM_SOURCE=config: bỏ qua NetBox dù có token.
const dcimCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/dcim.json'), 'utf8'));
const useNetbox = process.env.DCIM_SOURCE !== 'config' && process.env.DCIM_API_KEY && process.env.DCIM_API_TOKEN;
const netboxUrl = process.env.NETBOX_URL || (process.env.NETBOX_PORT ? `http://127.0.0.1:${process.env.NETBOX_PORT}/` : dcimCfg.netbox.url);
const dcimInventory = new DcimInventory({
  client: useNetbox ? new NetboxClient({ url: netboxUrl, token: `nbt_${process.env.DCIM_API_KEY}.${process.env.DCIM_API_TOKEN}`, timeoutMs: 8000 }) : null,
  dcim: dcimCfg,
  devices: cfg.devices,
  log: m => console.log(`[dcim] ${m}`),
});
const dcimCapacity = () => {
  const inventory = dcimInventory.get();
  return { ...computeCapacity({ inventory, dcim: dcimCfg, rules, values: last ? last.values : {}, ts: last ? last.ts : null }),
    sourceName: inventory.sourceName, sourceError: inventory.error, netboxUrl: useNetbox ? netboxUrl : null };
};

// Mất PDU sàn (pdu_input_lost): liệt kê máy chủ mất điện / chỉ còn một nguồn theo đường cấp điện trong DCIM,
// ghi vào ticket iTop và gắn các máy chủ đó làm CI (CMDB iTop nhận máy chủ từ NetBox qua npm run itsm:cmdb).
const IMPACT_RULES = new Set(['pdu_input_lost']);
const dcimImpact = pdu => {
  const inventory = dcimInventory.get();
  const impact = powerImpact(inventory, dcimCfg, pdu);
  return impact && { ...impact, sourceName: inventory.sourceName };
};
const itsmImpact = a => {
  if (!IMPACT_RULES.has(a.ruleId)) return null;
  const imp = dcimImpact(a.deviceId);
  if (!imp) return null;
  return { vi: impactLines(imp, 'vi', imp.sourceName), ja: impactLines(imp, 'ja', imp.sourceName),
    cis: [...imp.unpowered, ...imp.singleSourced].map(x => x.name) };
};

// ITSM (tùy chọn): cảnh báo → ticket iTop. Chỉ bật khi ITSM_ENABLED=1; không đặt thì demo chạy như cũ.
let itsm = null;
if (process.env.ITSM_ENABLED === '1') {
  const itsmUrl = process.env.ITSM_URL || `http://127.0.0.1:${process.env.ITOP_PORT || 8000}/`;
  if (!process.env.ITSM_PASSWORD) {
    console.error('[itsm] ITSM_ENABLED=1 nhưng thiếu ITSM_PASSWORD: ITSM bị tắt.');
  } else {
    const holdSec = process.env.ITSM_WARNING_HOLD_SEC;
    itsm = new ItsmConnector({
      client: new ItopClient({ url: itsmUrl, user: process.env.ITSM_USER || 'bms-itsm', password: process.env.ITSM_PASSWORD }),
      config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config/itsm.json'), 'utf8')),
      devices: cfg.devices,
      statePath: path.join(DATA, 'itsm-state.json'),
      holdSec: holdSec === undefined || holdSec === '' ? undefined : Number(holdSec),
      // Render tự đặt RENDER_EXTERNAL_URL (địa chỉ công khai của service) nên không cần khai báo thêm
      nocUrl: process.env.ITSM_NOC_URL || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/` : `http://127.0.0.1:${PORT}/`),
      itopUrl: itsmUrl,
      log: m => console.log(`[itsm] ${m}`),
      impact: itsmImpact,
    });
    // Lỗi trong bộ nối không được làm hỏng bộ cảnh báo
    alarms.on('event', e => {
      try { itsm.handle(e); } catch (err) { console.error(`[itsm] ${err.message}`); }
    });
  }
}

let last = null;
const sseClients = new Set();
collector.on('snapshot', snap => {
  history.push(snap.ts, snap.values);
  alarms.evaluate(snap);
  if (itsm) itsm.tick(snap.ts);
  last = { ...snap, alarms: alarms.list(), itsm: itsm ? itsm.snapshot() : null };
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

function proxyToSim(req, res) {
  const upstream = http.request(
    { host: SIM_HOST, port: SIM_CONTROL_PORT, path: '/api/faults', method: req.method, headers: { 'Content-Type': 'application/json' }, timeout: 3000 },
    up => {
      res.writeHead(up.statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      up.pipe(res);
    }
  );
  upstream.on('timeout', () => upstream.destroy(new Error('Simulator timeout')));
  upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Simulator unreachable' }); });
  if (req.method === 'POST') req.pipe(upstream);
  else upstream.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/healthz') return json(res, 200, { ok: true, polling: Boolean(last) });
  if (AUTH_PASSWORD && !checkBasicAuth(req.headers.authorization, AUTH_USER, AUTH_PASSWORD)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BMS Demo", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Authentication required');
  }
  try {
    if (SIM_PROXY && p === '/sim/api/faults' && (req.method === 'GET' || req.method === 'POST')) return proxyToSim(req, res);
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, {
        langs: LANGS,
        site: cfg.site,
        pollIntervalMs: cfg.pollIntervalMs,
        devices: cfg.devices.map(({ id, name, type, domain, unit, position, points }) => ({ id, name, type, domain, unit, position, points })),
        derived: cfg.derived,
        rules: rules.map(({ id, point, op, value, severity, type }) => ({ id, point, op, value, severity, type })),
        simControlPort: SIM_CONTROL_PORT,
        simControlPath: SIM_PROXY ? '/sim' : null,
        // Loại thiết bị lắp rack được (u > 0), cho công cụ "lắp vào đâu" trên dashboard
        dcim: {
          types: Object.entries(dcimCfg.deviceTypes)
            .filter(([k, t]) => !k.startsWith('$') && t.u > 0)
            .map(([key, t]) => ({ key, name: t.name, u: t.u, ratedKw: t.ratedKw })),
        },
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
    if (req.method === 'GET' && p === '/api/itsm') return json(res, 200, itsm ? itsm.snapshot() : { enabled: false });
    if (req.method === 'GET' && p === '/api/dcim/capacity') return json(res, 200, dcimCapacity());
    if (req.method === 'GET' && p === '/api/dcim/impact') {
      const imp = dcimImpact(url.searchParams.get('pdu') || 'pdua');
      return imp ? json(res, 200, imp) : json(res, 400, { error: 'Unknown PDU' });
    }
    if (req.method === 'GET' && p === '/api/dcim/plan') {
      // ?type=gpu8&count=2 (loại trong config/dcim.json) hoặc ?u=8&kw=10.2&count=2
      const t = dcimCfg.deviceTypes[url.searchParams.get('type')];
      const q = {
        u: t ? t.u : Number(url.searchParams.get('u')),
        ratedKw: t ? t.ratedKw : Number(url.searchParams.get('kw')),
        count: Number(url.searchParams.get('count') || 1),
      };
      if (url.searchParams.get('type') && !t) return json(res, 400, { error: 'Unknown device type' });
      return json(res, 200, planPlacement(dcimCapacity(), q));
    }
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
      if (last) {
        last.alarms = alarms.list();
        if (itsm) last.itsm = itsm.snapshot();
      }
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
  if (SIM_PROXY) console.log(`[bms] Demo mode: /sim/api/faults -> simulator ${SIM_HOST}:${SIM_CONTROL_PORT}`);
  console.log(`[bms] Basic auth: ${AUTH_PASSWORD ? `on (user "${AUTH_USER}")` : 'off'}`);
  console.log(`[bms] ITSM: ${itsm ? `on -> ${itsm.itopUrl} (warning hold ${itsm.holdMs / 1000} s)` : 'off'}`);
  console.log(`[bms] DCIM: hồ sơ từ ${useNetbox ? `NetBox ${netboxUrl} (dự phòng: config/dcim.json)` : 'config/dcim.json'}`);
  dcimInventory.refresh();
  collector.start();
});

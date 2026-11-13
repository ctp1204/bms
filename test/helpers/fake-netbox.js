'use strict';
// NetBox giả dùng chung cho các test DCIM (không phải file test).
const http = require('http');

const TOKEN = 'nbt_abcdefghijkl.0123456789012345678901234567890123456789';

// NetBox giả: lưu đối tượng theo endpoint, trả về đúng "hình dạng" của NetBox
// (khóa ngoại thành {id}, trường chọn thành {value,label}), lọc theo query, có phân trang.
// Giống NetBox: tạo thiết bị thì tự tạo cổng nguồn/ổ cắm theo cổng mẫu; tạo cáp thì ghi cable/link_peers lên hai đầu.
const FK = new Set(['site', 'location', 'manufacturer', 'device_type', 'role', 'power_panel', 'rack', 'power_port', 'device']);
const TERM_EP = { 'dcim.powerfeed': 'dcim/power-feeds/', 'dcim.powerport': 'dcim/power-ports/', 'dcim.poweroutlet': 'dcim/power-outlets/' };
const CHOICE = new Set(['status', 'type', 'supply', 'phase', 'form_factor', 'width', 'face']);
function fakeNetbox({ token = TOKEN, failOn } = {}) {
  const db = { store: {}, seq: 0, calls: [] };
  const shape = (fields, base = {}) => {
    const o = { ...base };
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'tags') o.tags = v.map(id => ({ id, name: 'tag' }));
      else if (FK.has(k)) o[k] = v === null ? null : { id: v, display: `#${v}` };
      else if (CHOICE.has(k)) o[k] = { value: v, label: String(v).toUpperCase() };
      else if (k === 'u_height') o[k] = Number(v).toFixed(1) * 1; // NetBox trả số thập phân
      else o[k] = v;
    }
    return o;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(403, { detail: 'Invalid v2 token' });
      const u = new URL(req.url, 'http://x');
      const m = u.pathname.match(/^\/api\/(.+?\/.+?\/)(\d+\/)?$/);
      if (!m) return send(404, { detail: 'Not found' });
      const [, ep, idPart] = m;
      db.calls.push(`${req.method} ${ep}`);
      if (failOn && failOn(req.method, ep)) return send(400, { name: ['bad value'] });
      const list = db.store[ep] || (db.store[ep] = []);
      if (req.method === 'GET') {
        const q = Object.fromEntries([...u.searchParams].filter(([k]) => !['limit', 'offset'].includes(k)));
        const hits = list.filter(o => Object.entries(q).every(([k, v]) => {
          const key = k.endsWith('_id') && k !== 'facility_id' ? k.slice(0, -3) : k;
          const cur = o[key];
          return String(cur && typeof cur === 'object' ? (cur.id ?? cur.value) : cur) === v;
        }));
        const limit = Number(u.searchParams.get('limit')) || 50;
        const offset = Number(u.searchParams.get('offset')) || 0;
        const more = offset + limit < hits.length;
        const nextUrl = new URL(req.url, `http://${req.headers.host}`);
        nextUrl.searchParams.set('offset', String(offset + limit));
        return send(200, { count: hits.length, next: more ? nextUrl.toString() : null, results: hits.slice(offset, offset + limit) });
      }
      const fields = JSON.parse(body);
      if (req.method === 'POST') {
        const o = shape(fields, { id: ++db.seq });
        if (ep === 'dcim/cables/') {
          const [a] = fields.a_terminations;
          const [b] = fields.b_terminations;
          const end = t => db.store[TERM_EP[t.object_type]].find(x => x.id === t.object_id);
          const [ea, eb] = [end(a), end(b)];
          if (ea.cable || eb.cable) return send(400, { __all__: ['termination already cabled'] });
          Object.assign(ea, { cable: { id: o.id }, link_peers_type: b.object_type, link_peers: [{ id: b.object_id }] });
          Object.assign(eb, { cable: { id: o.id }, link_peers_type: a.object_type, link_peers: [{ id: a.object_id }] });
        }
        // NetBox lọc power feed theo site qua tủ phân phối của nó
        if (ep === 'dcim/power-feeds/') o.site = (db.store['dcim/power-panels/'].find(pl => pl.id === fields.power_panel) || {}).site;
        list.push(o);
        if (ep === 'dcim/devices/') {
          const comp = (tplEp, outEp, extra) => (db.store[tplEp] || []).filter(t => t.device_type.id === fields.device_type)
            .map(t => { const c = { id: ++db.seq, device: { id: o.id }, site: o.site, name: t.name, cable: null, link_peers: [], link_peers_type: null, ...extra(t) };
              (db.store[outEp] || (db.store[outEp] = [])).push(c); return c; });
          const ports = comp('dcim/power-port-templates/', 'dcim/power-ports/', t => ({ maximum_draw: t.maximum_draw, allocated_draw: t.allocated_draw }));
          comp('dcim/power-outlet-templates/', 'dcim/power-outlets/', t => {
            const tpl = db.store['dcim/power-port-templates/'].find(p => p.id === t.power_port.id);
            return { power_port: { id: ports.find(p => p.name === tpl.name).id } };
          });
        }
        return send(201, o);
      }
      if (req.method === 'PATCH') {
        const i = list.findIndex(o => o.id === Number(idPart.slice(0, -1)));
        list[i] = shape(fields, list[i]);
        return send(200, list[i]);
      }
      return send(405, { detail: 'Method not allowed' });
    });
  });
  return { server, db };
}

async function withNetbox(opts, fn) {
  const { server, db } = fakeNetbox(opts);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/`, db);
  } finally {
    await new Promise(r => server.close(r));
  }
}

module.exports = { TOKEN, TERM_EP, fakeNetbox, withNetbox };

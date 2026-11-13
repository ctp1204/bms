'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { NetboxClient, NetboxError } = require('../src/netbox');
const { syncSkeleton, desiredDeviceTypes, slugify, same } = require('../src/dcim-sync');

const dcim = require(path.join(__dirname, '../config/dcim.json'));
const { devices } = require(path.join(__dirname, '../config/devices.json'));
const TOKEN = 'nbt_abcdefghijkl.0123456789012345678901234567890123456789';

// NetBox giả: lưu đối tượng theo endpoint, trả về đúng "hình dạng" của NetBox
// (khóa ngoại thành {id}, trường chọn thành {value,label}), lọc theo query, có phân trang.
const FK = new Set(['site', 'location', 'manufacturer', 'device_type', 'role', 'power_panel', 'rack', 'power_port']);
const CHOICE = new Set(['status', 'type', 'supply', 'phase', 'form_factor', 'width']);
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
        list.push(o);
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

test('slugify handles Vietnamese names; same() compares NetBox shapes with sent values', () => {
  assert.equal(slugify('Phòng máy 1'), 'phong-may-1');
  assert.equal(slugify('Đường dây'), 'duong-day');
  assert.equal(slugify('Rack PDU 3P 63A'), 'rack-pdu-3p-63a');
  assert.ok(same({ value: 'active', label: 'Active' }, 'active'));
  assert.ok(same({ id: 7, display: 'x' }, 7));
  assert.ok(same(42.0, 42));
  assert.ok(same([{ id: 2 }, { id: 1 }], [1, 2]));
  assert.ok(same('', null));
  assert.ok(!same({ value: 'planned' }, 'active'));
});

test('desired device types cover sample servers, rack PDU and infra devices', () => {
  const t = desiredDeviceTypes(dcim);
  const byKey = Object.fromEntries(t.map(x => [x.key, x]));
  assert.equal(byKey.gpu8.ratedW, 10200);
  assert.equal(byKey.gpu8.psu, 2);
  assert.equal(byKey.rpdu.outlets, 24);
  assert.equal(byKey.ups.u, 0);
  assert.equal(new Set(t.map(x => x.slug)).size, t.length, 'slugs must be unique');
});

test('first sync creates the skeleton; second sync changes nothing', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN, pageSize: 5 }); // trang nhỏ để thử phân trang
    const first = await syncSkeleton(client, dcim, devices);
    assert.equal(first.result.conflicts.length, 0);
    const count = ep => (db.store[ep] || []).length;
    assert.equal(count('dcim/sites/'), 1);
    assert.equal(count('dcim/locations/'), 1);
    assert.equal(count('dcim/racks/'), 6);
    assert.equal(count('dcim/device-types/'), desiredDeviceTypes(dcim).length);
    assert.equal(count('dcim/power-panels/'), 2);
    assert.equal(count('dcim/power-feeds/'), 12);
    assert.equal(count('dcim/power-outlet-templates/'), 24);
    // 5 loại máy chủ × 2 PSU + 1 cổng Input của thanh nguồn
    assert.equal(count('dcim/power-port-templates/'), 11);

    const r4 = db.store['dcim/racks/'].find(r => r.facility_id === 'bms:rack4');
    assert.equal(r4.name, 'R4');
    assert.equal(r4.u_height, 42);
    assert.equal(r4.location.id, db.store['dcim/locations/'][0].id);
    const feedB = db.store['dcim/power-feeds/'].find(f => f.name === 'R4-B');
    assert.equal(feedB.type.value, 'redundant');
    assert.equal(feedB.rack.id, r4.id);
    assert.equal(feedB.voltage, 400);
    const psu = db.store['dcim/power-port-templates/'].find(p => p.name === 'PSU1' && p.device_type.id === first.ids.deviceTypes.gpu8);
    assert.equal(psu.maximum_draw, 10200);
    assert.equal(psu.allocated_draw, 5100);
    const outlet = db.store['dcim/power-outlet-templates/'][0];
    assert.equal(outlet.power_port.id, db.store['dcim/power-port-templates/'].find(p => p.name === 'Input').id);

    const writesBefore = db.calls.filter(c => !c.startsWith('GET')).length;
    const second = await syncSkeleton(client, dcim, devices);
    assert.equal(second.result.created.length, 0);
    assert.equal(second.result.updated.length, 0);
    assert.equal(db.calls.filter(c => !c.startsWith('GET')).length, writesBefore, 'second run must not write');
    assert.deepEqual(second.ids, first.ids);
  });
});

test('a drifted field is patched back, without touching other fields', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    await syncSkeleton(client, dcim, devices);
    const rack = db.store['dcim/racks/'].find(r => r.name === 'R2');
    rack.u_height = 48;
    rack.status = { value: 'planned', label: 'Planned' };
    rack.comments = 'ghi chú của người vận hành';
    const lines = [];
    const { result } = await syncSkeleton(client, dcim, devices, m => lines.push(m));
    assert.deepEqual(result.updated.map(u => [u.label, u.fields.sort()]), [['rack R2', ['status', 'u_height']]]);
    const fixed = db.store['dcim/racks/'].find(r => r.name === 'R2');
    assert.equal(fixed.u_height, 42);
    assert.equal(fixed.status.value, 'active');
    assert.equal(fixed.comments, 'ghi chú của người vận hành', 'fields the sync does not own are left alone');
    assert.ok(lines.some(l => l.includes('cập nhật rack R2')));
  });
});

test('duplicates are reported as conflicts and never deleted', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    await syncSkeleton(client, dcim, devices);
    const racks = db.store['dcim/racks/'];
    racks.push({ ...racks[0], id: 999 }); // ai đó tạo tay một rack trùng facility_id
    const { result, ids } = await syncSkeleton(client, dcim, devices);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].label, 'rack R1');
    assert.equal(ids.racks.rack1, null);
    assert.equal(ids.feeds['rack1:A'], undefined, 'feeds for a conflicting rack are skipped');
    assert.equal(racks.length, 7, 'nothing deleted');
    assert.ok(!db.calls.some(c => c.startsWith('DELETE')));
  });
});

test('client errors carry HTTP code and NetBox field details', async () => {
  await withNetbox({ failOn: (method, ep) => method === 'POST' && ep === 'dcim/sites/' }, async url => {
    const client = new NetboxClient({ url, token: TOKEN });
    await assert.rejects(syncSkeleton(client, dcim, devices), e => e instanceof NetboxError && e.code === 'HTTP_400' && e.details.name[0] === 'bad value');
  });
  await withNetbox({}, async url => {
    const client = new NetboxClient({ url, token: 'nbt_wrong.token' });
    await assert.rejects(client.list('dcim/sites/'), e => e.code === 'HTTP_403' && /Invalid v2 token/.test(e.message));
  });
  const dead = new NetboxClient({ url: 'http://127.0.0.1:1/', token: TOKEN });
  await assert.rejects(dead.list('dcim/sites/'), e => e.code === 'NETWORK');
  assert.throws(() => new NetboxClient({ url: 'http://x/' }), /cần url và token/);
});

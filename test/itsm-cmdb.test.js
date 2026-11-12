'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { ItopClient, ItopError, oqlString } = require('../src/itop');
const { desiredCis, syncCmdb } = require('../src/itsm-cmdb');

const { devices } = require(path.join(__dirname, '../config/devices.json'));
const itsm = require(path.join(__dirname, '../config/itsm.json'));
const clone = o => JSON.parse(JSON.stringify(o));

// iTop giả: chỉ hiểu đúng những truy vấn mà src/itsm-cmdb.js gửi.
function fakeItop({ user = 'u', password = 'p', status = 200, delayMs = 0 } = {}) {
  const db = { objects: [], seq: 0, calls: [] };
  const nameIn = oql => (oql.match(/name = '([^']*)'/) || [])[1];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => setTimeout(() => {
      const form = new URLSearchParams(body);
      const send = obj => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (form.get('auth_user') !== user || form.get('auth_pwd') !== password) return send({ code: 1, message: 'Error: Invalid login' });
      const j = JSON.parse(form.get('json_data'));
      db.calls.push(j.operation);
      const out = o => ({ code: 0, objects: { [`${o.class}::${o.key}`]: { key: String(o.key), class: o.class, fields: o.fields } } });
      if (j.operation === 'core/get') {
        const prefix = (String(j.key).match(/LIKE '([^%']*)%'/) || [])[1] ?? '\0';
        const found = db.objects.filter(o => o.fields.asset_number.startsWith(prefix));
        return send({ code: 0, message: `Found: ${found.length}`, objects: Object.fromEntries(found.map(o => [`${o.class}::${o.key}`, { key: String(o.key), class: o.class, fields: o.fields }])) });
      }
      const resolve = f => {
        const g = { ...f };
        if (f.org_id) { g.org_id_friendlyname = nameIn(f.org_id); delete g.org_id; }
        if (f.location_id) { g.location_id_friendlyname = nameIn(f.location_id); delete g.location_id; }
        return g;
      };
      if (j.operation === 'core/create') {
        const o = { key: ++db.seq, class: j.class, fields: { ...resolve(j.fields), finalclass: j.class } };
        db.objects.push(o);
        return send(out(o));
      }
      if (j.operation === 'core/update') {
        const o = db.objects.find(x => x.key === j.key);
        Object.assign(o.fields, resolve(j.fields));
        return send(out(o));
      }
      return send({ code: 4, message: 'unknown operation' });
    }, delayMs));
  });
  return { server, db };
}

async function withItop(opts, fn) {
  const { server, db } = fakeItop(opts);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, db);
  } finally {
    await new Promise(r => server.close(r));
  }
}

test('desiredCis maps device types to iTop classes with a stable asset_number', () => {
  const ci = Object.fromEntries(desiredCis(devices, itsm).map(c => [c.deviceId, c]));
  assert.equal(ci.rack1.class, 'Rack');
  assert.equal(ci.pdua.class, 'PowerSource');
  assert.equal(ci.crah1.class, 'Peripheral');
  assert.equal(ci.rack1.assetNumber, 'bms:rack1');
  assert.equal(ci.msb1.fields.name, 'Tủ điện tổng MSB');
  assert.match(ci.msb1.fields.description, /日本語名: 主配電盤 MSB/);
  assert.equal(ci.leak1.fields.business_criticity, 'medium');
  assert.equal(new Set(Object.values(ci).map(c => c.assetNumber)).size, devices.length);
});

test('desiredCis refuses a device type without a CMDB class', () => {
  assert.throws(() => desiredCis([{ id: 'x1', type: 'mystery', domain: 'power', unit: 99, name: 'X' }], itsm), /classByType.*mystery/);
});

test('sync creates every CI once, then is a no-op, then updates only what changed', async () => {
  await withItop({}, async (url, db) => {
    const client = new ItopClient({ url, user: 'u', password: 'p' });
    const first = await syncCmdb(client, devices, itsm);
    assert.equal(first.created.length, devices.length);
    assert.equal(db.objects.length, devices.length);
    assert.equal(db.objects.find(o => o.fields.asset_number === 'bms:ats1').fields.location_id_friendlyname, itsm.cmdb.location);

    const second = await syncCmdb(client, devices, itsm);
    assert.equal(second.created.length + second.updated.length, 0);
    assert.equal(second.unchanged.length, devices.length);

    const renamed = clone(devices);
    renamed.find(d => d.id === 'ups1').name = 'UPS-1 (mới)';
    const third = await syncCmdb(client, renamed, itsm);
    assert.deepEqual(third.updated.map(u => [u.deviceId, u.fields]), [['ups1', ['name']]]);
    assert.equal(db.objects.length, devices.length, 'never creates duplicates');
  });
});

test('sync reports extra and wrong-class CIs instead of deleting or recreating them', async () => {
  await withItop({}, async (url, db) => {
    const client = new ItopClient({ url, user: 'u', password: 'p' });
    await syncCmdb(client, devices, itsm);
    db.objects.find(o => o.fields.asset_number === 'bms:pdua').fields.finalclass = 'PDU';
    const r = await syncCmdb(client, devices.filter(d => d.id !== 'leak1'), itsm);
    assert.deepEqual(r.extra.map(e => e.assetNumber), ['bms:leak1']);
    assert.deepEqual(r.conflicts.map(c => [c.deviceId, c.have, c.want]), [['pdua', 'PDU', 'PowerSource']]);
    assert.equal(db.objects.length, devices.length);
    assert.ok(!db.calls.includes('core/delete'));
  });
});

test('client turns iTop and transport failures into ItopError', async () => {
  await withItop({}, async url => {
    const bad = new ItopClient({ url, user: 'u', password: 'wrong' });
    await assert.rejects(bad.get('Incident', 1), e => e instanceof ItopError && e.code === 1);
  });
  await withItop({ status: 500 }, async url => {
    await assert.rejects(new ItopClient({ url, user: 'u', password: 'p' }).get('Incident', 1), { code: 'HTTP_500' });
  });
  await withItop({ delayMs: 300 }, async url => {
    await assert.rejects(new ItopClient({ url, user: 'u', password: 'p', timeoutMs: 50 }).get('Incident', 1), { code: 'TIMEOUT' });
  });
  await assert.rejects(new ItopClient({ url: 'http://127.0.0.1:1', user: 'u', password: 'p' }).get('Incident', 1), { code: 'NETWORK' });
});

test('oqlString escapes quotes and backslashes', () => {
  assert.equal(oqlString("R'1\\x"), "'R\\'1\\\\x'");
  assert.throws(() => new ItopClient({ url: 'http://x' }), /url, user và password/);
});

'use strict';
// Chạy cả chuỗi thật: AlarmEngine (luật thật trong alarms.json) → ItsmConnector → ItopClient (HTTP) → iTop giả.
// Bắt lỗi lệch dạng dữ liệu giữa bộ cảnh báo và bộ nối mà test dùng sự kiện tự tạo không thấy.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { AlarmEngine } = require('../src/alarms');
const { ItopClient } = require('../src/itop');
const { ItsmConnector } = require('../src/itsm');
const { LANGS } = require('../src/locale');

const cfg = require(path.join(__dirname, '../config/devices.json'));
const rules = require(path.join(__dirname, '../config/alarms.json'));
const itsmCfg = require(path.join(__dirname, '../config/itsm.json'));

// Dựng AlarmEngine giống src/index.js
function engine() {
  const pointMeta = {};
  for (const d of cfg.devices) for (const p of d.points) pointMeta[`${d.id}.${p.key}`] = { name: p.name, uom: p.uom || '', device: d.id, enum: p.enum, decimals: p.decimals };
  for (const p of cfg.derived) pointMeta[p.id] = { name: p.name, uom: p.uom, device: 'site', decimals: p.decimals };
  const deviceNames = Object.fromEntries(cfg.devices.map(d => [d.id, d.name]));
  return new AlarmEngine(rules, { pointMeta, deviceNames, langs: LANGS });
}

// iTop giả hiểu Incident: create / update / get
function fakeItop() {
  const db = { incidents: {}, seq: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(new URLSearchParams(body).get('json_data'));
      const reply = (key, fields) => res.end(JSON.stringify({ code: 0, objects: { [`Incident::${key}`]: { key: String(key), class: 'Incident', fields } } }));
      if (j.operation === 'core/create') {
        const key = ++db.seq;
        db.incidents[key] = { ...j.fields, ref: `I-${String(key).padStart(6, '0')}`, status: 'new', log: [], cis: [...(j.fields.functionalcis_list || [])] };
        return reply(key, { ref: db.incidents[key].ref });
      }
      const inc = db.incidents[j.key];
      if (j.operation === 'core/update') {
        if (j.fields.public_log) inc.log.push(j.fields.public_log.add_item.message);
        if (j.fields.functionalcis_list) inc.cis = j.fields.functionalcis_list;
        if (j.fields.urgency) inc.urgency = j.fields.urgency;
        return reply(j.key, {});
      }
      if (j.operation === 'core/get') return reply(j.key, { status: inc.status });
      return res.end(JSON.stringify({ code: 11, message: 'unknown operation' }));
    });
  });
  return { server, db };
}

async function setup(fn) {
  const { server, db } = fakeItop();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let now = 0;
  const conn = new ItsmConnector({
    client: new ItopClient({ url, user: 'u', password: 'p' }), config: itsmCfg, devices: cfg.devices, holdSec: 30, itopUrl: url, clock: () => now,
  });
  const eng = engine();
  eng.on('event', e => conn.handle(e));
  const step = (sec, values) => { now = sec * 1000; eng.evaluate({ ts: now, values, devices: {} }); conn.tick(now); };
  try {
    await fn({ step, conn, eng, db });
  } finally {
    await new Promise(r => server.close(r));
  }
}
const assets = list => list.map(l => l.functionalci_id.match(/'bms:(\w+)'/)[1]).sort();

test('real alarm engine: utility outage becomes one P1 incident with the full story in its log', () =>
  setup(async ({ step, conn, eng, db }) => {
    const normal = { 'ats1.utility_ok': 1, 'ats1.source': 0, 'ups1.mode': 0, 'crah1.status': 1, 'crah2.status': 1 };
    const outage = { 'ats1.utility_ok': 0, 'ats1.source': 2, 'ups1.mode': 1, 'crah1.status': 0, 'crah2.status': 0 };
    const onGen = { 'ats1.utility_ok': 0, 'ats1.source': 1, 'ups1.mode': 0, 'crah1.status': 1, 'crah2.status': 1 };
    step(0, normal);
    for (let s = 2; s <= 10; s += 2) step(s, outage);
    for (let s = 12; s <= 38; s += 2) step(s, onGen);
    step(40, normal);
    await conn.flush();

    const incs = Object.values(db.incidents);
    assert.equal(incs.length, 1, 'one incident for the whole outage');
    const inc = incs[0];
    assert.equal(inc.team_id, "SELECT Team WHERE name = 'DC Power'");
    assert.equal(inc.urgency, '1');
    assert.match(inc.title, /^\[Điện\] Sự cố nguồn cấp: Mất điện lưới/);
    assert.match(inc.description, /商用電源喪失/);
    assert.deepEqual(assets(inc.cis), ['ats1', 'crah1', 'crah2', 'ups1']);

    const log = inc.log.join('\n');
    for (const re of [/Phát sinh thêm: .*UPS-1/, /Phát sinh thêm: .*Không có nguồn sau ATS/, /Phát sinh thêm: .*CRAH-1/,
      /Thông tin: ATS đang cấp từ máy phát/, /Đã hết: Mất điện lưới/, /Tất cả cảnh báo trong nhóm đã hết/]) assert.match(log, re);

    const utility = eng.list().find(a => a.ruleId === 'utility_lost');
    eng.ack(utility.id, 'an', 41000);
    await conn.flush();
    assert.match(inc.log.at(-1), /Đã xác nhận trên NOC bởi an/);
    assert.equal(conn.snapshot().tickets[utility.key].ref, 'I-000001');
  }));

test('real alarm engine: rack warning waits 30 s after it is raised, then a critical escalates it', () =>
  setup(async ({ step, conn, db }) => {
    for (let s = 0; s <= 38; s += 2) step(s, { 'rack4.temp': 28 }); // phát sinh ở giây 10 (delaySec 10)
    await conn.flush();
    assert.equal(Object.keys(db.incidents).length, 0, 'raised at 10 s, hold until 40 s');
    step(40, { 'rack4.temp': 28 });
    await conn.flush();
    const [inc] = Object.values(db.incidents);
    assert.equal(inc.urgency, '3');
    assert.equal(inc.team_id, "SELECT Team WHERE name = 'DC Cooling'");
    assert.deepEqual(assets(inc.cis), ['rack4']);

    for (let s = 42; s <= 48; s += 2) step(s, { 'rack4.temp': 33 }); // rack_hot_crit sau 5 giây
    await conn.flush();
    assert.equal(Object.keys(db.incidents).length, 1);
    assert.equal(inc.urgency, '1', 'escalated to P1');
  }));

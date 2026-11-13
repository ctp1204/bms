'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { powerImpact, impactLines, feedAvailableKw } = require('../src/dcim-impact');
const { inventoryFromConfig } = require('../src/dcim-capacity');
const { ItsmConnector } = require('../src/itsm');
const { ItopError } = require('../src/itop');

const dcim = require(path.join(__dirname, '../config/dcim.json'));
const { devices } = require(path.join(__dirname, '../config/devices.json'));
const config = require(path.join(__dirname, '../config/itsm.json'));
const clone = o => JSON.parse(JSON.stringify(o));
const inv = () => inventoryFromConfig(dcim, devices);
const SERVERS = dcim.racks.reduce((s, r) => s + r.devices.length, 0);

test('losing PDU-A leaves every server on one source and loads each B feed with its whole rack', () => {
  const imp = powerImpact(inv(), dcim, 'pdua');
  assert.equal(imp.side, 'A');
  assert.equal(imp.unpowered.length, 0);
  assert.equal(imp.singleSourced.length, SERVERS);
  assert.ok(imp.singleSourced.every(x => x.feed.endsWith('-B')));
  assert.equal(imp.feeds.length, dcim.racks.length);
  assert.deepEqual(imp.feeds[0], { feed: 'R4-B', rack: 'R4', kw: 31.2, availableKw: 34.9, pct: 89, over: false }, 'fullest feed first');
  assert.equal(powerImpact(inv(), dcim, 'pdub').feeds[0].feed, 'R4-A');
  assert.equal(powerImpact(inv(), dcim, 'nope'), null);
  assert.ok(Math.abs(feedAvailableKw(dcim) - 34.917) < 0.01);
});

test('a server cabled only to the lost side goes down; a broken chain does not count as a source', () => {
  const i = inv();
  const r6 = i.racks.find(r => r.id === 'rack6');
  r6.devices[0].sources = r6.devices[0].sources.filter(s => s.side === 'A'); // chỉ cắm PSU1 vào A
  r6.devices[1].sources[1].side = null; // PSU2 cắm vào thanh nguồn chưa nối feed
  const imp = powerImpact(i, dcim, 'pdua');
  assert.deepEqual(imp.unpowered.map(x => x.name), ['R6-CMP-1', 'R6-CMP-2']);
  assert.equal(imp.singleSourced.length, SERVERS - 2);
  assert.equal(imp.feeds.find(f => f.feed === 'R6-B').kw, 1.8, 'only servers still powered load the feed');
});

test('an overloaded surviving feed is flagged', () => {
  const big = clone(dcim);
  big.power.feed.amperage = 32; // feed nhỏ: ~17,7 kW
  const imp = powerImpact(inventoryFromConfig(big, devices), big, 'pdua');
  const r4 = imp.feeds.find(f => f.feed === 'R4-B');
  assert.equal(r4.over, true);
  assert.match(impactLines(imp, 'vi', 'NetBox').join('\n'), /R4-B 31,2 kW \(176%\) QUÁ TẢI/);
  assert.match(impactLines(imp, 'ja', 'NetBox').join('\n'), /R4-B 31.2 kW \(176%\) 過負荷/);
});

test('impact lines are bilingual, grouped by rack, and say when nothing goes down', () => {
  const imp = powerImpact(inv(), dcim, 'pdua');
  const vi = impactLines(imp, 'vi', 'NetBox');
  assert.equal(vi[0], 'Ảnh hưởng theo hồ sơ DCIM (NetBox): mất PDU phía A.');
  assert.equal(vi[1], 'Mất điện hẳn: không có máy chủ nào.');
  assert.match(vi[2], new RegExp(`Chỉ còn một nguồn \\(mất dự phòng\\): ${SERVERS} máy chủ\\. R1: R1-GPU8-1, R1-GPU8-2, `));
  assert.match(vi[3], /khả dụng 34,9 kW\): R4-B 31,2 kW \(89%\)/);
  const ja = impactLines(imp, 'ja', 'config/dcim.json');
  assert.match(ja[0], /DCIM 台帳（config\/dcim.json）/);
  assert.match(ja[1], /該当サーバーなし/);
  const i = inv();
  i.racks[0].devices[0].sources = [];
  assert.match(impactLines(powerImpact(i, dcim, 'pdua'), 'vi', 'NetBox')[1], /^MẤT ĐIỆN HẲN: 1 máy chủ: R1: R1-GPU8-1\.$/);
});

// ---------- Ghi vào ticket iTop qua hook impact của bộ nối ----------

const T0 = Date.UTC(2026, 10, 13, 2, 0, 0);
function fakeClient() {
  const c = { creates: [], updates: [], fail: [], seq: 0 };
  const maybeFail = () => { const e = c.fail.shift(); if (e) throw e; };
  c.create = async (cls, fields) => { maybeFail(); const key = ++c.seq; c.creates.push({ fields, key }); return { key, class: cls, fields: { ref: `I-${key}` } }; };
  c.update = async (cls, key, fields) => { maybeFail(); c.updates.push({ key, fields }); return { key, class: cls, fields: {} }; };
  c.get = async (cls, key) => [{ key, class: cls, fields: { status: 'new' } }];
  return c;
}
const hook = a => {
  if (a.ruleId !== 'pdu_input_lost') return null;
  const imp = powerImpact(inv(), dcim, a.deviceId);
  return { vi: impactLines(imp, 'vi', 'NetBox'), ja: impactLines(imp, 'ja', 'NetBox'), cis: [...imp.unpowered, ...imp.singleSourced].map(x => x.name) };
};
function make(impact = hook) {
  const client = fakeClient();
  const logs = [];
  let now = T0;
  const conn = new ItsmConnector({ client, config, devices, holdSec: 30, clock: () => now, log: m => logs.push(m), impact });
  return { conn, client, logs, setNow: t => { now = t; } };
}
function ev(ruleId, sec, severity, device = 'pdua') {
  return { ts: T0 + sec * 1000, type: 'raised', alarm: { key: `${ruleId}:${device}`, ruleId, deviceId: device, point: `${device}.status`, severity, value: 1,
    messages: { vi: `${device}: ${ruleId}`, ja: `${device}：${ruleId}` } } };
}
const ciNames = fields => fields.functionalcis_list.map(l => l.functionalci_id.match(/'bms:([^']+)'/)[1]);

test('PDU input loss opens a ticket listing impact in both languages and linking affected servers', async () => {
  const { conn, client } = make();
  conn.handle(ev('pdu_input_lost', 0, 'critical'));
  await conn.flush();
  assert.equal(client.creates.length, 1);
  const f = client.creates[0].fields;
  assert.match(f.description, /<b>Ảnh hưởng:<\/b><\/p><ul><li>Ảnh hưởng theo hồ sơ DCIM \(NetBox\): mất PDU phía A\.<\/li>/);
  assert.match(f.description, /<b>影響:<\/b>/);
  assert.match(f.description, /片系給電のみ/);
  const cis = ciNames(f);
  assert.equal(cis[0], 'pdua');
  assert.equal(cis.length, 1 + SERVERS);
  assert.ok(cis.includes('R4-GPU8-3'));
});

test('when the PDU group already has a ticket, the impact goes into the note with the full CI list', async () => {
  const { conn, client, setNow } = make();
  conn.handle(ev('pdu_overload', 0, 'warning'));
  setNow(T0 + 30000);
  conn.tick(T0 + 30000);
  await conn.flush();
  assert.equal(client.creates.length, 1);
  assert.doesNotMatch(client.creates[0].fields.description, /Ảnh hưởng/, 'overload has no impact section');
  conn.handle(ev('pdu_input_lost', 40, 'critical'));
  await conn.flush();
  const note = client.updates.at(-1).fields;
  assert.match(note.public_log.add_item.message, /Ảnh hưởng:\nẢnh hưởng theo hồ sơ DCIM \(NetBox\): mất PDU phía A\./);
  assert.match(note.public_log.add_item.message, /影響：\n/);
  assert.equal(ciNames(note).length, 1 + SERVERS);
  assert.equal(note.urgency, '2', 'P3 overload escalated to P2 (pdu_input_lost is P2: the rack still has side B)');
});

test('a failing impact hook never costs the ticket', async () => {
  const { conn, client, logs } = make(() => { throw new Error('NetBox hỏng'); });
  conn.handle(ev('pdu_input_lost', 0, 'critical'));
  await conn.flush();
  assert.equal(client.creates.length, 1);
  assert.deepEqual(ciNames(client.creates[0].fields), ['pdua']);
  assert.ok(logs.some(l => l.includes('Bỏ qua phần ảnh hưởng (NetBox hỏng)')));
  const bad = make(() => ({ vi: 'không phải mảng' }));
  bad.conn.handle(ev('pdu_input_lost', 0, 'critical'));
  await bad.conn.flush();
  assert.doesNotMatch(bad.client.creates[0].fields.description, /Ảnh hưởng/);
});

test('a note whose CIs are missing in iTop is still written, without the CI list', async () => {
  const { conn, client, logs, setNow } = make();
  conn.handle(ev('pdu_overload', 0, 'warning'));
  setNow(T0 + 30000);
  conn.tick(T0 + 30000);
  await conn.flush();
  client.fail.push(new ItopError('Error: functionalci_id: Found no match', 100));
  conn.handle(ev('pdu_input_lost', 40, 'critical'));
  await conn.flush();
  const note = client.updates.at(-1).fields;
  assert.match(note.public_log.add_item.message, /Ảnh hưởng/);
  assert.equal(note.functionalcis_list, undefined);
  assert.ok(logs.some(l => l.includes('Ghi chú không kèm CI')));
  assert.equal(conn.snapshot().state, 'ok');
});

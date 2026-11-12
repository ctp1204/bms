'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ItsmConnector } = require('../src/itsm');
const { ItopError } = require('../src/itop');

const { devices } = require(path.join(__dirname, '../config/devices.json'));
const config = require(path.join(__dirname, '../config/itsm.json'));
const T0 = Date.UTC(2026, 10, 12, 2, 0, 0); // 09:00:00 giờ Việt Nam

// iTop giả ở mức client: ghi lại lệnh, cho phép cài lỗi cho lần gọi kế tiếp.
function fakeClient() {
  const c = { creates: [], updates: [], gets: [], status: {}, fail: [], seq: 0 };
  const maybeFail = () => { const e = c.fail.shift(); if (e) throw e; };
  c.create = async (cls, fields) => {
    maybeFail();
    const key = ++c.seq;
    c.creates.push({ cls, fields, key });
    c.status[key] = 'new';
    return { key, class: cls, fields: { ref: `I-${String(key).padStart(6, '0')}` } };
  };
  c.update = async (cls, key, fields) => { maybeFail(); c.updates.push({ key, fields }); return { key, class: cls, fields: {} }; };
  c.get = async (cls, key) => { maybeFail(); c.gets.push(key); return [{ key, class: cls, fields: { status: c.status[key] } }]; };
  return c;
}

const MSG = {
  utility_lost: ['ats1', 'ats1.utility_ok', 'critical', 'Mất điện lưới', '商用電源喪失', 0],
  ups_battery: ['ups1', 'ups1.mode', 'critical', 'UPS-1: đang chạy pin', 'UPS-1：バッテリー運転中', 1],
  crah_stopped: ['crah1', 'crah1.status', 'critical', 'CRAH-1: dừng', 'CRAH-1：停止', 0],
  chiller_stopped: ['chiller1', 'chiller1.status', 'warning', 'Chiller-1: dừng', 'Chiller-1：停止', 0],
  on_generator: ['ats1', 'ats1.source', 'info', 'ATS đang cấp từ máy phát', 'ATS は発電機から給電中', 1],
  rack_hot_warn: ['rack4', 'rack4.temp', 'warning', 'Rack R4: inlet 27.6°C', 'ラック R4：吸気 27.6°C', 27.6],
  rack_hot_crit: ['rack4', 'rack4.temp', 'critical', 'Rack R4: inlet 32.4°C', 'ラック R4：吸気 32.4°C', 32.4],
  pdu_input_lost: [null, null, 'critical', 'mất nguồn đầu vào', '入力電源喪失', 1],
  pdu_overload: [null, null, 'warning', 'tải vượt 80%', '定格の 80% を超過', 120],
  pue_high: ['site', 'site.pue', 'info', 'PUE cao', 'PUE 高', 1.7],
};
// Sự kiện "raised"; dùng { ...ev(...), type: 'cleared' | 'acked' } cho các loại khác.
function ev(ruleId, ts, { device, user } = {}) {
  const type = 'raised';
  const [dev, point, severity, vi, ja, value] = MSG[ruleId];
  const deviceId = device || dev;
  const p = point || `${deviceId}.total_kw`;
  return { ts, type, alarm: { key: `${ruleId}:${p}`, ruleId, deviceId, point: p, severity, value, messages: { vi: `${vi} <x>`, ja }, ackedBy: user } };
}

function make(opts = {}) {
  const client = opts.client || fakeClient();
  let now = opts.now ?? T0;
  const conn = new ItsmConnector({
    client, config, devices, holdSec: 30, nocUrl: 'http://noc/', itopUrl: 'http://itop', statePath: opts.statePath, clock: () => now,
  });
  return { conn, client, setNow: t => { now = t; } };
}
const s = n => T0 + n * 1000;
const logs = u => u.fields.public_log.add_item.message;

test('utility outage: one P1 ticket for the power team, later alarms become notes with their CIs', async () => {
  const { conn, client } = make();
  conn.handle(ev('utility_lost', s(0)));
  conn.handle(ev('ups_battery', s(0)));
  conn.handle(ev('crah_stopped', s(3)));
  conn.handle(ev('chiller_stopped', s(3))); // warning: nhóm đã mở nên ghi chú ngay, không chờ
  conn.handle(ev('on_generator', s(10))); // info: chỉ ghi chú
  await conn.flush();

  assert.equal(client.creates.length, 1);
  const f = client.creates[0].fields;
  assert.equal(f.team_id, "SELECT Team WHERE name = 'DC Power'");
  assert.deepEqual([f.impact, f.urgency, f.origin], ['2', '1', 'monitoring']);
  assert.match(f.title, /^\[Điện\] Sự cố nguồn cấp: Mất điện lưới/);
  assert.deepEqual(f.functionalcis_list.map(l => l.functionalci_id.match(/'bms:(\w+)'/)[1]), ['ats1']);
  assert.match(f.description, /09:00:00 Mất điện lưới &lt;x&gt; \(ats1\.utility_ok = 0\)/, 'time in Asia/Ho_Chi_Minh, HTML escaped');
  assert.match(f.description, /商用電源喪失/);
  assert.match(f.description, /phản hồi 15 phút, xử lý 4 giờ/);
  assert.match(f.description, /http:\/\/noc\/#power/);

  assert.equal(client.updates.length, 4);
  assert.match(logs(client.updates[0]), /Phát sinh thêm: UPS-1: đang chạy pin/);
  assert.deepEqual(client.updates[0].fields.functionalcis_list.map(l => l.functionalci_id.match(/'bms:(\w+)'/)[1]), ['ats1', 'ups1'], 'sends the full CI list');
  assert.match(logs(client.updates[2]), /Chiller-1: dừng/);
  assert.match(logs(client.updates[3]), /Thông tin: ATS đang cấp từ máy phát/);
  assert.ok(!client.updates.some(u => u.fields.urgency), 'nothing outranks P1');
  assert.equal(conn.snapshot().tickets['utility_lost:ats1.utility_ok'].ref, 'I-000001');
});

test('warning waits for the hold time; a warning that clears in time never opens a ticket', async () => {
  const { conn, client } = make();
  conn.handle(ev('rack_hot_warn', s(0)));
  conn.tick(s(29));
  await conn.flush();
  assert.equal(client.creates.length, 0);
  conn.tick(s(30));
  await conn.flush();
  assert.equal(client.creates.length, 1);
  assert.equal(client.creates[0].fields.urgency, '3');
  assert.equal(client.creates[0].fields.team_id, "SELECT Team WHERE name = 'DC Cooling'");

  const b = make();
  b.conn.handle(ev('pdu_overload', s(0), { device: 'pdua' }));
  b.conn.handle({ ...ev('pdu_overload', s(20), { device: 'pdua' }), type: 'cleared' });
  b.conn.tick(s(60));
  await b.conn.flush();
  assert.equal(b.client.creates.length, 0);
});

test('a heavier alarm raises priority; a lighter one never lowers it', async () => {
  const { conn, client } = make();
  conn.handle(ev('rack_hot_warn', s(0)));
  conn.tick(s(30));
  conn.handle(ev('rack_hot_crit', s(40)));
  conn.handle({ ...ev('rack_hot_crit', s(50)), type: 'cleared' });
  await conn.flush();
  assert.equal(client.creates.length, 1);
  const up = client.updates.find(u => u.fields.urgency);
  assert.deepEqual([up.fields.impact, up.fields.urgency], ['2', '1']);
  assert.match(logs(up), /Nâng ưu tiên lên P1 · 優先度を P1 に引き上げ/);
  assert.equal(client.updates.filter(u => u.fields.urgency).length, 1);
});

test('device-scoped groups: one ticket per PDU, same PDU alarms are notes', async () => {
  const { conn, client } = make();
  conn.handle(ev('pdu_input_lost', s(0), { device: 'pdua' }));
  conn.handle(ev('pdu_input_lost', s(1), { device: 'pdub' }));
  conn.handle(ev('pdu_overload', s(5), { device: 'pdub' }));
  await conn.flush();
  assert.equal(client.creates.length, 2);
  assert.equal(client.creates[0].fields.urgency, '2', 'pdu_input_lost is P2: the rack still has the other feed');
  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0].key, 2);
});

test('all cleared → note; re-raise inside the window → note; after the window → new ticket that references the old one', async () => {
  const { conn, client } = make();
  conn.handle(ev('utility_lost', s(0)));
  conn.handle({ ...ev('utility_lost', s(60)), type: 'cleared' });
  conn.handle({ ...ev('utility_lost', s(61), { user: 'an' }), type: 'acked' });
  await conn.flush();
  assert.match(logs(client.updates[0]), /Đã hết: Mất điện lưới/);
  assert.match(logs(client.updates[1]), /Tất cả cảnh báo trong nhóm đã hết/);
  assert.match(logs(client.updates[2]), /Đã xác nhận trên NOC bởi an/);

  conn.handle(ev('utility_lost', s(600)));
  await conn.flush();
  assert.equal(client.creates.length, 1, 'inside 30 min: same ticket');

  conn.handle({ ...ev('utility_lost', s(700)), type: 'cleared' });
  conn.handle(ev('utility_lost', s(700 + 1801)));
  await conn.flush();
  assert.equal(client.creates.length, 2);
  assert.match(client.creates[1].fields.description, /Tiếp nối ticket I-000001 đã đóng/);
});

test('info and ignored alarms never open tickets', async () => {
  const { conn, client } = make();
  conn.handle(ev('on_generator', s(0)));
  conn.handle(ev('pue_high', s(0)));
  conn.tick(s(3600));
  await conn.flush();
  assert.equal(client.creates.length + client.updates.length, 0);
});

test('network failure: job stays queued, retried later, delivered exactly once', async () => {
  const { conn, client, setNow } = make();
  client.fail.push(new ItopError('connect ECONNREFUSED', 'NETWORK'));
  conn.handle(ev('utility_lost', s(0)));
  await conn.flush();
  assert.equal(client.creates.length, 0);
  assert.equal(conn.snapshot().state, 'retrying');
  assert.equal(conn.snapshot().queue, 1);

  conn.handle(ev('ups_battery', s(1))); // vẫn xếp hàng phía sau, không mất thứ tự
  setNow(s(1)); conn.tick(s(1)); await conn.flush();
  assert.equal(client.creates.length, 0, 'waits for the back-off');
  setNow(s(3)); conn.tick(s(3)); await conn.flush();
  assert.equal(client.creates.length, 1);
  assert.equal(client.updates.length, 1);
  assert.deepEqual([conn.snapshot().state, conn.snapshot().queue], ['ok', 0]);
});

test('unknown CI in CMDB: ticket is still created, without CI links', async () => {
  const { conn, client } = make();
  client.fail.push(new ItopError('functionalci_id: no item found', 100));
  conn.handle(ev('utility_lost', s(0)));
  await conn.flush();
  assert.equal(client.creates.length, 1);
  assert.equal(client.creates[0].fields.functionalcis_list, undefined);
});

test('ticket closed by a human while the alarm comes back: open a new ticket instead of writing to the closed one', async () => {
  const { conn, client } = make();
  conn.handle(ev('rack_hot_crit', s(0)));
  await conn.flush();
  client.status[1] = 'closed';
  conn.handle(ev('rack_hot_warn', s(10)));
  await conn.flush();
  assert.equal(client.creates.length, 2);
  assert.match(client.creates[1].fields.description, /Tiếp nối ticket I-000001/);
  assert.equal(client.updates.length, 0);
});

test('restart: state is reloaded and re-raised alarms attach to the existing ticket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itsm-'));
  const statePath = path.join(dir, 'itsm-state.json');
  try {
    const a = make({ statePath });
    a.conn.handle(ev('utility_lost', s(0)));
    await a.conn.flush();

    const b = make({ statePath, client: a.client, now: s(120) });
    b.conn.handle(ev('utility_lost', s(120))); // bộ cảnh báo mới phát sinh lại sau khởi động
    await b.conn.flush();
    assert.equal(a.client.creates.length, 1);
    assert.equal(a.client.updates.length, 1);
    assert.equal(b.conn.snapshot().tickets['utility_lost:ats1.utility_ok'].url, 'http://itop/pages/UI.php?operation=details&class=Incident&id=1');

    // Lệnh chưa gửi được cũng được giữ qua khởi động lại
    a.client.fail.push(new ItopError('down', 'NETWORK'));
    b.conn.handle(ev('pdu_input_lost', s(130), { device: 'pdua' }));
    await b.conn.flush();
    const c = make({ statePath, client: a.client, now: s(200) });
    assert.equal(c.conn.snapshot().queue, 1);
    await c.conn.flush();
    assert.equal(a.client.creates.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

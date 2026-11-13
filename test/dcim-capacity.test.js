'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { NetboxClient } = require('../src/netbox');
const { syncDcim } = require('../src/dcim-sync');
const { inventoryFromConfig, inventoryFromNetbox, freeBlocks, computeCapacity, planPlacement, DcimInventory } = require('../src/dcim-capacity');
const { TOKEN, withNetbox } = require('./helpers/fake-netbox');

const dcim = require(path.join(__dirname, '../config/dcim.json'));
const { devices } = require(path.join(__dirname, '../config/devices.json'));
const rules = require(path.join(__dirname, '../config/alarms.json'));
const { Plant } = require('../sim/plant');

// Số đo giống bộ giả lập lúc bình thường: tải rack chia đều hai PDU, nhiệt độ quanh 24 °C
function normalValues(over = {}) {
  const plant = new Plant({ random: () => 0.5 });
  const v = { 'pdua.status': 0, 'pdub.status': 0 };
  plant.rackKw.forEach((kw, i) => {
    v[`pdua.r${i + 1}_kw`] = kw / 2;
    v[`pdub.r${i + 1}_kw`] = kw / 2;
    v[`rack${i + 1}.temp`] = 24;
  });
  v['pdua.total_kw'] = plant.rackKw.reduce((s, x) => s + x, 0) / 2;
  v['pdub.total_kw'] = v['pdua.total_kw'];
  return { ...v, ...over };
}
const cap = (values, inventory = inventoryFromConfig(dcim, devices)) => computeCapacity({ inventory, dcim, rules, values });
const rack = (c, id) => c.racks.find(r => r.id === id);

test('inventory read back from NetBox equals the config it was synced from', async () => {
  await withNetbox({}, async url => {
    const client = new NetboxClient({ url, token: TOKEN });
    await syncDcim(client, dcim, devices);
    const fromNb = await inventoryFromNetbox(client, dcim);
    assert.equal(fromNb.source, 'netbox');
    assert.deepEqual(fromNb.racks, inventoryFromConfig(dcim, devices).racks);
  });
});

test('NetBox is the source of truth: a server added there shows up in capacity', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    const { ids } = await syncDcim(client, dcim, devices);
    await client.create('dcim/devices/', { name: 'R6-GPU8-NEW', site: ids.site, rack: ids.racks.rack6, position: 10, face: 'front',
      device_type: ids.deviceTypes.gpu8, role: ids.roles['gpu-server'], status: 'active' });
    const inv = await inventoryFromNetbox(client, dcim);
    const r6 = rack(cap({}, inv), 'rack6');
    assert.equal(r6.u.used, 5 + 8);
    assert.equal(r6.power.ratedKw, 13.8);
    assert.deepEqual(r6.u.blocks, [{ start: 5, size: 5 }, { start: 18, size: 24 }]);
    assert.equal(db.store['dcim/devices/'].length > 0, true);
  });
});

test('missing NetBox site gives a clear message', async () => {
  await withNetbox({}, async url => {
    await assert.rejects(inventoryFromNetbox(new NetboxClient({ url, token: TOKEN }), dcim), /chưa có site dxai-dc.*dcim:sync/);
  });
});

test('freeBlocks lists contiguous empty U ranges from the bottom', () => {
  assert.deepEqual(freeBlocks({ uHeight: 10, devices: [{ position: 1, u: 2 }, { position: 6, u: 1 }, { position: 10, u: 1 }] }),
    [{ start: 3, size: 3 }, { start: 7, size: 3 }]);
  assert.deepEqual(freeBlocks({ uHeight: 4, devices: [] }), [{ start: 1, size: 4 }]);
});

test('capacity uses measured kW per rack, levels by budget %, and tracks floor PDUs against 2N', () => {
  const c = cap(normalValues());
  assert.equal(c.source, 'config');
  const r4 = rack(c, 'rack4');
  assert.equal(r4.power.measuredKw, 29.9);
  assert.equal(r4.power.headroomKw, 5.1);
  assert.equal(r4.power.level, 'warn'); // 85% ngân sách: vượt 70%, chưa tới 90%
  assert.equal(rack(c, 'rack6').power.level, 'ok');
  assert.equal(rack(c, 'rack6').u.largestFree, 37);
  assert.equal(r4.thermal.headroomC, 3);
  assert.deepEqual(c.floor.map(f => [f.side, f.measuredKw, f.headroomTo2nKw, f.level]), [['A', 60, 10, 'ok'], ['B', 60, 10, 'ok']]);
  assert.equal(c.totals.measuredKw, 120);
  assert.equal(c.totals.freeU, dcim.racks.length * 42 - dcim.racks.reduce((s, r) => s + r.devices.reduce((a, d) => a + dcim.deviceTypes[d.type].u, 0), 0));
});

test('without readings, capacity falls back to rated power and marks thermal unknown', () => {
  const r1 = rack(cap({}), 'rack1');
  assert.equal(r1.power.measuredKw, null);
  assert.equal(r1.power.headroomKw, round(35 - 27.4));
  assert.equal(r1.thermal.level, 'unknown');
  assert.equal(r1.level, 'warn');
  assert.deepEqual(cap({}).floor.map(f => f.level), ['unknown', 'unknown']);
  function round(x) { return Math.round(x * 10) / 10; }
});

test('hot rack, PDU over 2N and PDU input loss raise the right levels', () => {
  const c = cap(normalValues({ 'rack4.temp': 33, 'rack2.temp': 28, 'pdub.total_kw': 75, 'pdua.status': 1, 'pdua.total_kw': 0 }));
  assert.equal(rack(c, 'rack4').thermal.level, 'crit');
  assert.equal(rack(c, 'rack4').level, 'crit');
  assert.equal(rack(c, 'rack2').thermal.level, 'warn');
  assert.deepEqual(c.floor.map(f => [f.side, f.inputLost, f.level]), [['A', true, 'crit'], ['B', false, 'warn']]);
});

test('plan: one 8-GPU server goes to R6 and keeps 2N; R1 and R4 lack power', () => {
  const p = planPlacement(cap(normalValues()), { u: 8, ratedKw: 10.2, count: 1 });
  assert.equal(p.best, 'rack6');
  assert.equal(p.keeps2n, true);
  const r4 = p.candidates.find(x => x.rack === 'rack4');
  assert.equal(r4.fits, false);
  assert.deepEqual(r4.reasons.map(x => x.code), ['power']);
  assert.deepEqual(p.floor.map(f => f.afterKw), [65.1, 65.1]);
  assert.ok(p.candidates[0].fits && p.candidates[0].rack === 'rack6', 'best candidate first');
});

test('plan: two 8-GPU servers still fit in R6 but break 2N on the floor PDUs', () => {
  const p = planPlacement(cap(normalValues()), { u: 8, ratedKw: 10.2, count: 2 });
  assert.equal(p.best, 'rack6');
  assert.equal(p.keeps2n, false);
  assert.deepEqual(p.floor.map(f => [f.afterKw, f.keeps2n]), [[70.2, false], [70.2, false]]);
});

test('plan: space and temperature reasons; nothing fits gives best = null; bad input throws', () => {
  const tall = planPlacement(cap(normalValues()), { u: 40, ratedKw: 1, count: 1 });
  assert.equal(tall.best, null);
  assert.ok(tall.candidates.every(c => c.reasons.some(r => r.code === 'space')));
  const hot = planPlacement(cap(normalValues({ 'rack6.temp': 28 })), { u: 1, ratedKw: 0.5 });
  assert.deepEqual(hot.candidates.find(c => c.rack === 'rack6').reasons.map(r => r.code), ['thermal']);
  assert.notEqual(hot.best, 'rack6');
  const unknown = planPlacement(cap({}), { u: 1, ratedKw: 0.5 });
  assert.equal(unknown.keeps2n, true, 'unknown floor readings do not claim a 2N loss');
  assert.throws(() => planPlacement(cap({}), { u: 0, ratedKw: 1 }), /u > 0/);
  assert.throws(() => planPlacement(cap({}), { u: 1, ratedKw: 1, count: 0 }), /count/);
});

test('DcimInventory: config without client; NetBox when reachable; keeps last copy on error; refreshes when stale', async () => {
  const noClient = new DcimInventory({ dcim, devices });
  assert.equal(noClient.get().source, 'config');
  assert.equal(noClient.get().sourceName, 'config/dcim.json');
  assert.equal(await noClient.refresh(), noClient.current);

  await withNetbox({}, async url => {
    const good = new NetboxClient({ url, token: TOKEN });
    await syncDcim(good, dcim, devices);
    let now = 0;
    const logs = [];
    const inv = new DcimInventory({ client: new NetboxClient({ url: 'http://127.0.0.1:1/', token: TOKEN }), dcim, devices, refreshMs: 1000, clock: () => now, log: m => logs.push(m) });
    await inv.refresh();
    assert.equal(inv.get().source, 'config');
    assert.match(inv.get().error, /ECONNREFUSED|connect/);
    assert.ok(logs.some(l => l.includes('dùng config/dcim.json')));

    inv.client = good;
    now = 500;
    inv.get(); // chưa cũ: không làm mới
    assert.equal(inv._loading, null);
    now = 2000;
    inv.get(); // đã cũ: làm mới ở nền
    await inv._loading;
    assert.equal(inv.get().source, 'netbox');
    assert.equal(inv.get().error, null);

    inv.client = new NetboxClient({ url: 'http://127.0.0.1:1/', token: TOKEN });
    await inv.refresh();
    assert.equal(inv.get().source, 'netbox', 'keeps last NetBox copy');
    assert.ok(logs.some(l => l.includes('bản gần nhất')));
    const [a, b] = [inv.refresh(), inv.refresh()];
    assert.equal(a, b, 'concurrent refreshes share one request');
    await a;
  });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { NetboxClient, NetboxError } = require('../src/netbox');
const { TOKEN, TERM_EP, withNetbox } = require('./helpers/fake-netbox');
const { syncDcim, syncSkeleton, desiredDeviceTypes, slugify, same } = require('../src/dcim-sync');

const dcim = require(path.join(__dirname, '../config/dcim.json'));
const { devices } = require(path.join(__dirname, '../config/devices.json'));

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

test('full sync places infra devices, rack PDUs and sample servers, and wires PSU1→A, PSU2→B', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    const { result, ids } = await syncDcim(client, dcim, devices);
    assert.equal(result.conflicts.length, 0);
    const devs = db.store['dcim/devices/'];
    const servers = dcim.racks.flatMap(r => r.devices);
    const infra = devices.filter(d => dcim.infra[d.type].kind === 'device');
    assert.equal(devs.length, infra.length + dcim.racks.length * 2 + servers.length);
    assert.equal(db.store['dcim/cables/'].length, dcim.racks.length * 2 + servers.length * 2);

    const ups = devs.find(d => d.asset_tag === 'bms:ups1');
    assert.equal(ups.name, 'UPS-1');
    assert.equal(ups.rack, undefined, 'infra devices stand in the room, not in a rack');
    assert.equal(ups.role.id, ids.roles.ups);

    const byId = id => devs.find(d => d.id === id);
    const peerOf = (ep, devId, name) => {
      const c = db.store[ep].find(x => x.device.id === devId && x.name === name);
      return { c, peer: db.store[TERM_EP[c.link_peers_type]].find(x => x.id === c.link_peers[0].id) };
    };
    const gpu = devs.find(d => d.name === 'R4-GPU8-2'); // máy thứ 2 trong R4 → Outlet 2
    assert.equal(gpu.position, 9);
    assert.equal(gpu.face.value, 'front');
    for (const [psu, side] of [['PSU1', 'A'], ['PSU2', 'B']]) {
      const { peer } = peerOf('dcim/power-ports/', gpu.id, psu);
      assert.equal(peer.name, 'Outlet 2');
      assert.equal(byId(peer.device.id).name, `R4-RPDU-${side}`);
    }
    const { c: input, peer: feed } = peerOf('dcim/power-ports/', ids.devices['R4-RPDU-B'], 'Input');
    assert.equal(feed.name, 'R4-B');
    assert.equal(input.maximum_draw, null, 'rack PDU input aggregates downstream draw in NetBox');
  });
});

test('second full sync writes nothing', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    await syncDcim(client, dcim, devices);
    const writes = () => db.calls.filter(c => !c.startsWith('GET')).length;
    const before = writes();
    const { result } = await syncDcim(client, dcim, devices);
    assert.equal(result.created.length + result.updated.length + result.conflicts.length, 0);
    assert.equal(writes(), before);
  });
});

test('a cable plugged into the wrong outlet is a conflict, never unplugged', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    const { ids } = await syncDcim(client, dcim, devices);
    // Đổi đầu ổ cắm của cáp vào R6-CMP-1 PSU1 sang Outlet 20 (ai đó cắm lại bằng tay)
    const ports = db.store['dcim/power-ports/'];
    const outlets = db.store['dcim/power-outlets/'];
    const psu = ports.find(p => p.device.id === ids.devices['R6-CMP-1'] && p.name === 'PSU1');
    const old = outlets.find(o => o.id === psu.link_peers[0].id);
    const moved = outlets.find(o => o.device.id === ids.devices['R6-RPDU-A'] && o.name === 'Outlet 20');
    Object.assign(moved, { cable: old.cable, link_peers_type: 'dcim.powerport', link_peers: [{ id: psu.id }] });
    Object.assign(old, { cable: null, link_peers_type: null, link_peers: [] });
    psu.link_peers = [{ id: moved.id }];
    const lines = [];
    const { result } = await syncDcim(client, dcim, devices, m => lines.push(m));
    assert.deepEqual(result.conflicts.map(c => c.label), ['R6-RPDU-A Outlet 1 → R6-CMP-1 PSU1']);
    assert.ok(lines.some(l => l.includes('XUNG ĐỘT cáp')));
    assert.equal(result.created.length, 0, 'no second cable is added to the PSU');
    assert.ok(!db.calls.some(c => c.startsWith('DELETE')));
  });
});

test('a missing component template fails with a clear message', async () => {
  await withNetbox({}, async (url, db) => {
    const client = new NetboxClient({ url, token: TOKEN });
    const skel = await syncSkeleton(client, dcim, devices);
    db.store['dcim/power-port-templates/'] = db.store['dcim/power-port-templates/'].filter(t => t.name !== 'Input');
    db.store['dcim/power-outlet-templates/'] = [];
    const { syncDevices } = require('../src/dcim-sync');
    await assert.rejects(syncDevices(client, dcim, devices, skel), /không có Input .*cổng mẫu/);
  });
});

'use strict';
// Đồng bộ CI vào CMDB của iTop:
// - 16 thiết bị hạ tầng được giám sát (config/devices.json): khóa asset_number = cmdb.assetPrefix + id thiết bị;
// - máy chủ trong rack, lấy từ hồ sơ DCIM (NetBox là nguồn gốc): khóa asset_number = cmdb.assetPrefix + tên máy,
//   gắn vào Rack tương ứng. Nhờ vậy ticket mất PDU gắn được các máy chủ bị ảnh hưởng.
// Chạy lại nhiều lần không tạo trùng. Không bao giờ xóa CI: CI có tiền tố mà không còn trong nguồn chỉ được báo là "thừa".

const { loc } = require('./locale');
const { oqlString } = require('./itop');

const COMPARE = ['name', 'description', 'business_criticity', 'status'];

// servers: [{ name, rack: id cảm biến rack trong devices.json (vd. 'rack4'), type, ratedKw }]
function desiredCis(devices, itsm, servers = []) {
  const { cmdb, itop } = itsm;
  const byId = Object.fromEntries(devices.map(d => [d.id, d]));
  const infra = devices.map(d => {
    const cls = cmdb.classByType[d.type];
    if (!cls) throw new Error(`Thiếu cmdb.classByType cho loại thiết bị "${d.type}" (${d.id})`);
    const nameJa = loc(d.name, 'ja');
    const name = loc(d.name, 'vi');
    return {
      deviceId: d.id,
      class: cls,
      assetNumber: `${cmdb.assetPrefix}${d.id}`,
      fields: {
        name,
        description: `BMS · EPMS Demo: ${d.type}, ${d.domain}, Modbus unit ${d.unit}.${nameJa !== name ? ` 日本語名: ${nameJa}` : ''}`,
        business_criticity: cmdb.criticalityByType[d.type] || 'medium',
        status: cmdb.status,
      },
      refs: { organization: itop.organization, location: cmdb.location },
    };
  });
  const srv = servers.map(s => {
    const rack = byId[s.rack];
    if (!rack) throw new Error(`Máy chủ ${s.name}: rack ${s.rack} không có trong devices.json`);
    return {
      deviceId: s.name,
      class: cmdb.serverClass,
      assetNumber: `${cmdb.assetPrefix}${s.name}`,
      fields: {
        name: s.name,
        description: `BMS · EPMS Demo: máy chủ mẫu từ DCIM (NetBox) · ${s.type} · ${s.ratedKw} kW. DCIM のサンプルサーバー。`,
        business_criticity: cmdb.serverCriticality,
        status: cmdb.status,
      },
      refs: { organization: itop.organization, location: cmdb.location,
        rack: { assetNumber: `${cmdb.assetPrefix}${s.rack}`, name: loc(rack.name, 'vi') } },
    };
  });
  return [...infra, ...srv];
}

async function syncCmdb(client, devices, itsm, log = () => {}, servers = []) {
  const want = desiredCis(devices, itsm, servers);
  const prefix = itsm.cmdb.assetPrefix;
  const existing = await client.get('PhysicalDevice',
    `SELECT PhysicalDevice WHERE asset_number LIKE ${oqlString(`${prefix}%`)}`,
    `${COMPARE.join(',')},asset_number,finalclass,org_id_friendlyname,location_id_friendlyname`);
  const byAsset = new Map(existing.map(o => [o.fields.asset_number, o]));
  // Rack của máy chủ là thuộc tính của lớp Server, không có ở PhysicalDevice: đọc riêng
  if (servers.length) {
    const cls = itsm.cmdb.serverClass;
    const rows = await client.get(cls, `SELECT ${cls} WHERE asset_number LIKE ${oqlString(`${prefix}%`)}`, 'asset_number,rack_id_friendlyname');
    for (const o of rows) if (byAsset.has(o.fields.asset_number)) byAsset.get(o.fields.asset_number).fields.rack_id_friendlyname = o.fields.rack_id_friendlyname;
  }
  const result = { created: [], updated: [], unchanged: [], conflicts: [], extra: [] };

  for (const ci of want) {
    const cur = byAsset.get(ci.assetNumber);
    byAsset.delete(ci.assetNumber);
    const refFields = {
      org_id: `SELECT Organization WHERE name = ${oqlString(ci.refs.organization)}`,
      location_id: `SELECT Location WHERE name = ${oqlString(ci.refs.location)}`,
      ...(ci.refs.rack ? { rack_id: `SELECT Rack WHERE asset_number = ${oqlString(ci.refs.rack.assetNumber)}` } : {}),
    };
    if (!cur) {
      const o = await client.create(ci.class, { ...ci.fields, ...refFields, asset_number: ci.assetNumber }, { comment: 'bms-itsm CMDB sync' });
      result.created.push({ deviceId: ci.deviceId, class: ci.class, key: o.key });
      log(`  tạo      ${ci.class} ${ci.fields.name} (${ci.assetNumber})`);
      continue;
    }
    if (cur.fields.finalclass !== ci.class) {
      // Đổi lớp CI cần xóa rồi tạo lại: để người làm, không tự động.
      result.conflicts.push({ deviceId: ci.deviceId, want: ci.class, have: cur.fields.finalclass, key: cur.key });
      log(`  XUNG ĐỘT ${ci.assetNumber}: iTop là ${cur.fields.finalclass}, cấu hình muốn ${ci.class}. Bỏ qua.`);
      continue;
    }
    const diff = {};
    for (const k of COMPARE) if (String(cur.fields[k] ?? '') !== String(ci.fields[k])) diff[k] = ci.fields[k];
    if (cur.fields.org_id_friendlyname !== ci.refs.organization) diff.org_id = refFields.org_id;
    if (cur.fields.location_id_friendlyname !== ci.refs.location) diff.location_id = refFields.location_id;
    if (ci.refs.rack && cur.fields.rack_id_friendlyname !== ci.refs.rack.name) diff.rack_id = refFields.rack_id;
    if (Object.keys(diff).length === 0) {
      result.unchanged.push({ deviceId: ci.deviceId, key: cur.key });
      continue;
    }
    await client.update(ci.class, cur.key, diff, { comment: 'bms-itsm CMDB sync' });
    result.updated.push({ deviceId: ci.deviceId, key: cur.key, fields: Object.keys(diff) });
    log(`  cập nhật ${ci.class} ${ci.fields.name}: ${Object.keys(diff).join(', ')}`);
  }

  for (const o of byAsset.values()) {
    result.extra.push({ assetNumber: o.fields.asset_number, key: o.key });
    log(`  thừa     ${o.fields.asset_number} (${o.fields.finalclass} #${o.key}) không còn trong devices.json / DCIM. Không xóa.`);
  }
  return result;
}

module.exports = { desiredCis, syncCmdb };

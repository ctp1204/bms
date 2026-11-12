'use strict';
// Đồng bộ danh sách thiết bị (config/devices.json) thành CI trong CMDB của iTop.
// Khóa liên kết: asset_number = cmdb.assetPrefix + id thiết bị. Chạy lại nhiều lần không tạo trùng.
// Không bao giờ xóa CI: CI có tiền tố mà không còn trong devices.json chỉ được báo là "thừa".

const { loc } = require('./locale');
const { oqlString } = require('./itop');

const COMPARE = ['name', 'description', 'business_criticity', 'status'];

function desiredCis(devices, itsm) {
  const { cmdb, itop } = itsm;
  return devices.map(d => {
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
}

async function syncCmdb(client, devices, itsm, log = () => {}) {
  const want = desiredCis(devices, itsm);
  const prefix = itsm.cmdb.assetPrefix;
  const existing = await client.get('PhysicalDevice',
    `SELECT PhysicalDevice WHERE asset_number LIKE ${oqlString(`${prefix}%`)}`,
    `${COMPARE.join(',')},asset_number,finalclass,org_id_friendlyname,location_id_friendlyname`);
  const byAsset = new Map(existing.map(o => [o.fields.asset_number, o]));
  const result = { created: [], updated: [], unchanged: [], conflicts: [], extra: [] };

  for (const ci of want) {
    const cur = byAsset.get(ci.assetNumber);
    byAsset.delete(ci.assetNumber);
    const refFields = {
      org_id: `SELECT Organization WHERE name = ${oqlString(ci.refs.organization)}`,
      location_id: `SELECT Location WHERE name = ${oqlString(ci.refs.location)}`,
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
    log(`  thừa     ${o.fields.asset_number} (${o.fields.finalclass} #${o.key}) không còn trong devices.json. Không xóa.`);
  }
  return result;
}

module.exports = { desiredCis, syncCmdb };

'use strict';
// Đẩy 16 thiết bị trong config/devices.json và các máy chủ trong rack (từ DCIM) vào CMDB của iTop.
// Chạy lại được bất cứ lúc nào. Dùng tài khoản riêng bms-cmdb (Configuration Manager), không dùng tài khoản tạo ticket.
// Biến môi trường: ITSM_URL, ITSM_CMDB_USER, ITSM_CMDB_PASSWORD (đọc từ itsm/.env nếu chưa đặt).
// Máy chủ lấy từ NetBox (nguồn gốc) khi có DCIM_API_KEY / DCIM_API_TOKEN (đọc từ dcim/.env nếu chưa đặt);
// không có thì lấy từ config/dcim.json. DCIM_SOURCE=config: bỏ qua NetBox.

const fs = require('fs');
const path = require('path');
const { ItopClient } = require('../src/itop');
const { syncCmdb } = require('../src/itsm-cmdb');
const { NetboxClient } = require('../src/netbox');
const { inventoryFromConfig, inventoryFromNetbox } = require('../src/dcim-capacity');

const ROOT = path.join(__dirname, '..');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const env = { ...readEnvFile(path.join(ROOT, 'dcim/.env')), ...readEnvFile(path.join(ROOT, 'itsm/.env')), ...process.env };
  const url = env.ITSM_URL || `http://127.0.0.1:${env.ITOP_PORT || 8000}/`;
  const client = new ItopClient({ url, user: env.ITSM_CMDB_USER || 'bms-cmdb', password: env.ITSM_CMDB_PASSWORD });
  const { devices } = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/devices.json'), 'utf8'));
  const itsm = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/itsm.json'), 'utf8'));

  const dcim = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/dcim.json'), 'utf8'));
  let inventory;
  if (env.DCIM_SOURCE !== 'config' && env.DCIM_API_KEY && env.DCIM_API_TOKEN) {
    const nbUrl = env.NETBOX_URL || (env.NETBOX_PORT ? `http://127.0.0.1:${env.NETBOX_PORT}/` : dcim.netbox.url);
    inventory = await inventoryFromNetbox(new NetboxClient({ url: nbUrl, token: `nbt_${env.DCIM_API_KEY}.${env.DCIM_API_TOKEN}` }), dcim, devices);
    console.log(`[cmdb] Máy chủ lấy từ NetBox ${nbUrl}`);
  } else {
    inventory = inventoryFromConfig(dcim, devices);
    console.log('[cmdb] Máy chủ lấy từ config/dcim.json (chưa cấu hình NetBox)');
  }
  const servers = inventory.racks.flatMap(r => r.devices.map(d => ({ name: d.name, rack: r.id, type: d.type, ratedKw: d.ratedKw })));

  console.log(`[cmdb] Đồng bộ ${devices.length} thiết bị hạ tầng + ${servers.length} máy chủ vào ${url}`);
  const r = await syncCmdb(client, devices, itsm, msg => console.log(msg), servers);
  console.log(`[cmdb] tạo ${r.created.length} · cập nhật ${r.updated.length} · không đổi ${r.unchanged.length} · xung đột ${r.conflicts.length} · thừa ${r.extra.length}`);
  if (r.conflicts.length) process.exitCode = 2;
}

main().catch(e => {
  console.error(`[cmdb] Lỗi: ${e.message}`);
  process.exitCode = 1;
});

'use strict';
// Đẩy 16 thiết bị trong config/devices.json vào CMDB của iTop. Chạy lại được bất cứ lúc nào.
// Dùng tài khoản riêng bms-cmdb (Configuration Manager), không dùng tài khoản tạo ticket.
// Biến môi trường: ITSM_URL, ITSM_CMDB_USER, ITSM_CMDB_PASSWORD. Nếu chưa đặt, đọc từ itsm/.env.

const fs = require('fs');
const path = require('path');
const { ItopClient } = require('../src/itop');
const { syncCmdb } = require('../src/itsm-cmdb');

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
  const env = { ...readEnvFile(path.join(ROOT, 'itsm/.env')), ...process.env };
  const url = env.ITSM_URL || `http://127.0.0.1:${env.ITOP_PORT || 8000}/`;
  const client = new ItopClient({ url, user: env.ITSM_CMDB_USER || 'bms-cmdb', password: env.ITSM_CMDB_PASSWORD });
  const { devices } = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/devices.json'), 'utf8'));
  const itsm = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/itsm.json'), 'utf8'));

  console.log(`[cmdb] Đồng bộ ${devices.length} thiết bị vào ${url}`);
  const r = await syncCmdb(client, devices, itsm, msg => console.log(msg));
  console.log(`[cmdb] tạo ${r.created.length} · cập nhật ${r.updated.length} · không đổi ${r.unchanged.length} · xung đột ${r.conflicts.length} · thừa ${r.extra.length}`);
  if (r.conflicts.length) process.exitCode = 2;
}

main().catch(e => {
  console.error(`[cmdb] Lỗi: ${e.message}`);
  process.exitCode = 1;
});

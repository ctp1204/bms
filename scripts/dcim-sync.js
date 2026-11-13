'use strict';
// Đồng bộ mô hình DCIM vào NetBox. Chạy lại được bất cứ lúc nào; không bao giờ xóa dữ liệu trong NetBox.
// Dùng tài khoản API bms-dcim. Biến môi trường: NETBOX_URL, DCIM_API_KEY, DCIM_API_TOKEN.
// Nếu chưa đặt, đọc từ dcim/.env (do dcim/install.sh tạo).

const fs = require('fs');
const path = require('path');
const { NetboxClient } = require('../src/netbox');
const { syncDcim } = require('../src/dcim-sync');

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
  const env = { ...readEnvFile(path.join(ROOT, 'dcim/.env')), ...process.env };
  if (!env.DCIM_API_KEY || !env.DCIM_API_TOKEN) throw new Error('Thiếu DCIM_API_KEY / DCIM_API_TOKEN. Chạy ./dcim/install.sh trước.');
  const dcim = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/dcim.json'), 'utf8'));
  const { devices } = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/devices.json'), 'utf8'));
  const url = env.NETBOX_URL || (env.NETBOX_PORT ? `http://127.0.0.1:${env.NETBOX_PORT}/` : dcim.netbox.url);
  const client = new NetboxClient({ url, token: `nbt_${env.DCIM_API_KEY}.${env.DCIM_API_TOKEN}` });

  console.log(`[dcim] Đồng bộ DCIM (khung, thiết bị, cáp nguồn) vào ${url}`);
  const { result: r } = await syncDcim(client, dcim, devices, msg => console.log(msg));
  console.log(`[dcim] tạo ${r.created.length} · cập nhật ${r.updated.length} · không đổi ${r.unchanged.length} · xung đột ${r.conflicts.length}`);
  if (r.conflicts.length) process.exitCode = 2;
}

main().catch(e => {
  console.error(`[dcim] Lỗi: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details));
  process.exitCode = 1;
});

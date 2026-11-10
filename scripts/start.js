'use strict';
// Chạy bộ giả lập và BMS thành hai tiến trình riêng (như thực tế: thiết bị và phần mềm là hai hệ thống).

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const procs = [
  ['sim', path.join(root, 'sim/index.js')],
  ['bms', path.join(root, 'src/index.js')],
].map(([name, file]) => {
  const child = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
  child.on('exit', code => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown();
  });
  return child;
});

function shutdown() {
  for (const p of procs) if (p.exitCode === null) p.kill();
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

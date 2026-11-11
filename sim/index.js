'use strict';
// Bộ giả lập thiết bị: một "Modbus gateway" chứa tất cả thiết bị (mỗi thiết bị một unit id),
// cộng một HTTP API nhỏ để bật/tắt sự cố. HTTP API này thuộc bộ giả lập, KHÔNG thuộc BMS.

const http = require('http');
const { createServer, ModbusException, EXCEPTION } = require('../src/modbus');
const { Plant, FAULTS, FAULT_DOMAIN } = require('./plant');

// Dùng SIM_HOST (không dùng HOST) để khi BMS mở ra internet (HOST=0.0.0.0), bộ giả lập vẫn chỉ nằm nội bộ
const HOST = process.env.SIM_HOST || '127.0.0.1';
const MODBUS_PORT = Number(process.env.SIM_MODBUS_PORT || 5020);
const CONTROL_PORT = Number(process.env.SIM_CONTROL_PORT || 5021);
const SPEED = Number(process.env.SIM_SPEED || 1);
const STEP_MS = 500;

function onListenError(port) {
  return err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sim] Cổng ${port} đang bị chiếm (có thể một bản demo khác đang chạy). Tắt nó hoặc đặt biến môi trường để đổi cổng.`);
    } else {
      console.error(`[sim] ${err.message}`);
    }
    process.exit(1);
  };
}

const plant = new Plant();
setInterval(() => plant.step((STEP_MS / 1000) * SPEED), STEP_MS);

const modbus = createServer(({ unit, address, quantity }) => {
  const regs = plant.registers(unit);
  if (!regs) throw new ModbusException(EXCEPTION.GATEWAY_TARGET_FAILED);
  if (address + quantity > regs.length) throw new ModbusException(EXCEPTION.ILLEGAL_DATA_ADDRESS);
  return regs.slice(address, address + quantity);
});
modbus.on('error', onListenError(MODBUS_PORT));
modbus.listen(MODBUS_PORT, HOST, () => console.log(`[sim] Modbus TCP gateway on ${HOST}:${MODBUS_PORT}`));

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

const faultList = () => ({
  faults: Object.entries(FAULTS).map(([id, label]) => ({ id, label, domain: FAULT_DOMAIN[id], active: plant.faults.has(id) })),
});

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && req.url === '/api/faults') return send(res, 200, faultList());
    if (req.method === 'POST' && req.url === '/api/faults') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const { id, active } = JSON.parse(body || '{}');
          plant.setFault(id, Boolean(active));
          console.log(`[sim] fault ${id} -> ${Boolean(active)}`);
          send(res, 200, faultList());
        } catch (e) {
          send(res, 400, { error: e.message });
        }
      });
      return undefined;
    }
    return send(res, 404, { error: 'Not found' });
  })
  .on('error', onListenError(CONTROL_PORT))
  .listen(CONTROL_PORT, HOST, () => console.log(`[sim] Fault control API on http://${HOST}:${CONTROL_PORT}`));

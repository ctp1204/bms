'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const m = require('../src/modbus');

test('request/response frames round-trip', () => {
  const req = m.decodeRequest(m.encodeReadRequest(7, 21, 4, 3, 2));
  assert.deepEqual(req, { tid: 7, unit: 21, fc: 4, address: 3, quantity: 2 });
  const res = m.decodeResponse(m.encodeReadResponse(7, 21, 4, [0x00fa, 0xff38]));
  assert.deepEqual(res, { tid: 7, unit: 21, fc: 4, registers: [250, 0xff38] });
  assert.equal(m.toSigned16(0xff38), -200);
  const ex = m.decodeResponse(m.encodeException(7, 21, 4, m.EXCEPTION.GATEWAY_TARGET_FAILED));
  assert.equal(ex.exception, 0x0b);
  assert.equal(ex.fc, 4);
});

test('client has no write capability (BMS layer is read-only)', () => {
  const proto = Object.getOwnPropertyNames(m.ModbusTcpClient.prototype);
  assert.ok(proto.every(n => !/write/i.test(n)), `unexpected method in ${proto}`);
  assert.deepEqual(Object.values(m.FC).sort(), [3, 4]);
});

async function withServer(handler, fn) {
  const server = m.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new m.ModbusTcpClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 500 });
  try {
    await fn(client, server);
  } finally {
    client.close();
    await new Promise(r => server.close(r));
  }
}

test('client reads registers from server, concurrently', async () => {
  await withServer(
    ({ unit, address, quantity }) => Array.from({ length: quantity }, (_, i) => unit * 100 + address + i),
    async client => {
      const [a, b] = await Promise.all([client.readInputRegisters(1, 0, 3), client.readHoldingRegisters(2, 5, 2)]);
      assert.deepEqual(a, [100, 101, 102]);
      assert.deepEqual(b, [205, 206]);
    }
  );
});

test('server exceptions surface as ModbusException', async () => {
  await withServer(
    () => {
      throw new m.ModbusException(m.EXCEPTION.GATEWAY_TARGET_FAILED);
    },
    async client => {
      await assert.rejects(client.readInputRegisters(24, 0, 2), e => e instanceof m.ModbusException && e.code === 0x0b);
    }
  );
});

test('server rejects write function codes', async () => {
  await withServer(
    () => [1],
    async (_client, server) => {
      const sock = net.createConnection(server.address().port, '127.0.0.1');
      // FC6 write single register: tid=1, len=6, unit=1, addr=0, value=99
      const frame = Buffer.from([0, 1, 0, 0, 0, 6, 1, 6, 0, 0, 0, 99]);
      const reply = await new Promise(resolve => {
        sock.once('data', resolve);
        sock.write(frame);
      });
      sock.destroy();
      const res = m.decodeResponse(reply);
      assert.equal(res.exception, m.EXCEPTION.ILLEGAL_FUNCTION);
    }
  );
});

test('client rejects on connection refused and on invalid quantity', async () => {
  const client = new m.ModbusTcpClient({ host: '127.0.0.1', port: 1, timeoutMs: 300 });
  await assert.rejects(client.readInputRegisters(1, 0, 1));
  await assert.rejects(client.readInputRegisters(1, 0, 0), RangeError);
});

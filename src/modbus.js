'use strict';
// Modbus TCP tối giản (chuẩn Modbus Application Protocol v1.1b3).
// Client CHỈ có hàm đọc (FC3, FC4): BMS demo này không bao giờ gửi lệnh ghi xuống thiết bị.

const net = require('net');

const FC = Object.freeze({ READ_HOLDING_REGISTERS: 3, READ_INPUT_REGISTERS: 4 });
const READ_FCS = new Set([FC.READ_HOLDING_REGISTERS, FC.READ_INPUT_REGISTERS]);
const EXCEPTION = Object.freeze({
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SERVER_DEVICE_FAILURE: 0x04,
  GATEWAY_TARGET_FAILED: 0x0b,
});
const MAX_READ_QTY = 125;

class ModbusException extends Error {
  constructor(code, message) {
    super(message || `Modbus exception 0x${code.toString(16).padStart(2, '0')}`);
    this.code = code;
  }
}

// MBAP header (7 byte): transaction id, protocol id (=0), length, unit id
function encodeReadRequest(tid, unit, fc, address, quantity) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(6, 4);
  b.writeUInt8(unit, 6);
  b.writeUInt8(fc, 7);
  b.writeUInt16BE(address, 8);
  b.writeUInt16BE(quantity, 10);
  return b;
}

function decodeRequest(frame) {
  const req = { tid: frame.readUInt16BE(0), unit: frame.readUInt8(6), fc: frame.readUInt8(7) };
  if (READ_FCS.has(req.fc) && frame.length >= 12) {
    req.address = frame.readUInt16BE(8);
    req.quantity = frame.readUInt16BE(10);
  }
  return req;
}

function encodeReadResponse(tid, unit, fc, registers) {
  const b = Buffer.alloc(9 + registers.length * 2);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(3 + registers.length * 2, 4);
  b.writeUInt8(unit, 6);
  b.writeUInt8(fc, 7);
  b.writeUInt8(registers.length * 2, 8);
  registers.forEach((r, i) => b.writeUInt16BE(r & 0xffff, 9 + i * 2));
  return b;
}

function encodeException(tid, unit, fc, code) {
  const b = Buffer.alloc(9);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(3, 4);
  b.writeUInt8(unit, 6);
  b.writeUInt8((fc | 0x80) & 0xff, 7);
  b.writeUInt8(code, 8);
  return b;
}

function decodeResponse(frame) {
  const res = { tid: frame.readUInt16BE(0), unit: frame.readUInt8(6), fc: frame.readUInt8(7) };
  if (res.fc & 0x80) {
    res.fc &= 0x7f;
    res.exception = frame.readUInt8(8);
    return res;
  }
  const byteCount = frame.readUInt8(8);
  if (byteCount % 2 !== 0 || frame.length < 9 + byteCount) throw new Error('Malformed Modbus response');
  res.registers = [];
  for (let i = 0; i < byteCount; i += 2) res.registers.push(frame.readUInt16BE(9 + i));
  return res;
}

// TCP là luồng byte: gom dữ liệu và cắt thành từng frame theo trường length của MBAP.
function createFrameSplitter(onFrame, onError) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 7) {
      const len = buf.readUInt16BE(4);
      if (buf.readUInt16BE(2) !== 0 || len < 2 || len > 254) {
        buf = Buffer.alloc(0);
        onError(new Error('Invalid MBAP header'));
        return;
      }
      const total = 6 + len;
      if (buf.length < total) return;
      const frame = buf.subarray(0, total);
      buf = buf.subarray(total);
      onFrame(frame);
    }
  };
}

const toSigned16 = v => (v >= 0x8000 ? v - 0x10000 : v);

// Server dùng cho bộ giả lập. handler({unit, fc, address, quantity}) trả về mảng thanh ghi
// hoặc ném ModbusException. Chỉ hỗ trợ FC3/FC4.
function createServer(handler) {
  return net.createServer(socket => {
    socket.on('error', () => {});
    socket.on(
      'data',
      createFrameSplitter(
        frame => {
          const req = decodeRequest(frame);
          let res;
          if (!READ_FCS.has(req.fc)) {
            res = encodeException(req.tid, req.unit, req.fc, EXCEPTION.ILLEGAL_FUNCTION);
          } else if (req.quantity === undefined || req.quantity < 1 || req.quantity > MAX_READ_QTY) {
            res = encodeException(req.tid, req.unit, req.fc, EXCEPTION.ILLEGAL_DATA_VALUE);
          } else {
            try {
              res = encodeReadResponse(req.tid, req.unit, req.fc, handler(req));
            } catch (e) {
              const code = e instanceof ModbusException ? e.code : EXCEPTION.SERVER_DEVICE_FAILURE;
              res = encodeException(req.tid, req.unit, req.fc, code);
            }
          }
          socket.write(res);
        },
        () => socket.destroy()
      )
    );
  });
}

class ModbusTcpClient {
  constructor({ host = '127.0.0.1', port = 502, timeoutMs = 1000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.tid = 0;
    this.pending = new Map();
    this.socket = null;
    this.connecting = null;
  }

  _connect() {
    if (this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      s.setTimeout(this.timeoutMs);
      const fail = err => {
        this.connecting = null;
        s.destroy();
        reject(err);
      };
      s.once('error', fail);
      s.once('timeout', () => fail(new Error('Connect timeout')));
      s.once('connect', () => {
        s.removeAllListeners('error');
        s.removeAllListeners('timeout');
        s.setTimeout(0);
        s.setNoDelay(true);
        s.on('error', () => {});
        s.on('close', () => this._drop(new Error('Connection closed')));
        s.on('data', createFrameSplitter(f => this._onFrame(f), () => s.destroy()));
        this.socket = s;
        this.connecting = null;
        resolve();
      });
    });
    return this.connecting;
  }

  _drop(err) {
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _onFrame(frame) {
    let res;
    try {
      res = decodeResponse(frame);
    } catch {
      return;
    }
    const p = this.pending.get(res.tid);
    if (!p) return;
    this.pending.delete(res.tid);
    clearTimeout(p.timer);
    if (res.exception) p.reject(new ModbusException(res.exception));
    else if (res.unit !== p.unit || res.fc !== p.fc) p.reject(new Error('Response does not match request'));
    else if (res.registers.length !== p.quantity) p.reject(new Error('Unexpected register count'));
    else p.resolve(res.registers);
  }

  async _read(fc, unit, address, quantity) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_READ_QTY) {
      throw new RangeError(`quantity must be 1..${MAX_READ_QTY}`);
    }
    await this._connect();
    this.tid = (this.tid + 1) & 0xffff;
    const tid = this.tid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new Error('Timeout'));
      }, this.timeoutMs);
      this.pending.set(tid, { resolve, reject, timer, unit, fc, quantity });
      this.socket.write(encodeReadRequest(tid, unit, fc, address, quantity));
    });
  }

  readHoldingRegisters(unit, address, quantity) {
    return this._read(FC.READ_HOLDING_REGISTERS, unit, address, quantity);
  }

  readInputRegisters(unit, address, quantity) {
    return this._read(FC.READ_INPUT_REGISTERS, unit, address, quantity);
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

module.exports = {
  FC,
  EXCEPTION,
  ModbusException,
  ModbusTcpClient,
  createServer,
  encodeReadRequest,
  decodeRequest,
  encodeReadResponse,
  encodeException,
  decodeResponse,
  toSigned16,
};

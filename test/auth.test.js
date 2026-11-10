'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkBasicAuth } = require('../src/auth');

const header = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test('accepts correct credentials, including ":" inside the password', () => {
  assert.equal(checkBasicAuth(header('demo', 's3cret'), 'demo', 's3cret'), true);
  assert.equal(checkBasicAuth(header('demo', 'a:b'), 'demo', 'a:b'), true);
});

test('rejects wrong or malformed credentials', () => {
  assert.equal(checkBasicAuth(header('demo', 'wrong'), 'demo', 's3cret'), false);
  assert.equal(checkBasicAuth(header('admin', 's3cret'), 'demo', 's3cret'), false);
  assert.equal(checkBasicAuth(undefined, 'demo', 's3cret'), false);
  assert.equal(checkBasicAuth('Bearer abc', 'demo', 's3cret'), false);
  assert.equal(checkBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`, 'demo', 's3cret'), false);
});

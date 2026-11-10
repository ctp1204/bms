'use strict';
// Basic Auth tối giản cho bản demo đưa lên internet. Bật khi đặt BASIC_AUTH_PASSWORD.
// Chỉ an toàn khi chạy sau HTTPS (Render tự cấp HTTPS).

const crypto = require('crypto');

// So sánh hằng thời gian để không lộ mật khẩu qua thời gian phản hồi
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// header: giá trị của "Authorization". Trả về true nếu đúng user/password.
function checkBasicAuth(header, user, password) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const okUser = safeEqual(decoded.slice(0, i), user);
  const okPass = safeEqual(decoded.slice(i + 1), password);
  return okUser && okPass;
}

module.exports = { checkBasicAuth };

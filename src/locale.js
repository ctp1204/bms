'use strict';
// Chuỗi đa ngôn ngữ trong file cấu hình: hoặc là chuỗi thường (dùng chung mọi ngôn ngữ),
// hoặc là object { vi: "...", ja: "..." }.

const LANGS = Object.freeze(['vi', 'ja']);
const DEFAULT_LANG = 'vi';

function loc(value, lang = DEFAULT_LANG) {
  if (value && typeof value === 'object') return value[lang] ?? value[DEFAULT_LANG] ?? Object.values(value)[0];
  return value;
}

// vi: dấu phẩy thập phân (25,3); ja: dấu chấm (25.3)
function formatNumber(v, lang = DEFAULT_LANG) {
  const s = String(v);
  return lang === 'vi' ? s.replace('.', ',') : s;
}

module.exports = { LANGS, DEFAULT_LANG, loc, formatNumber };

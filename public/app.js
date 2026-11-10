'use strict';
/* global document, window, fetch, EventSource, location, getComputedStyle, localStorage, navigator, I18N */

const S = { cfg: null, meta: {}, snap: null, tab: 'active', simUrl: '', lastAlarmSig: '', lang: 'vi' };
const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const val = id => (S.snap ? S.snap.values[id] : undefined);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- Ngôn ngữ ---------- */
const LANGS = Object.keys(I18N);
// Chuỗi giao diện: t('kpi.inletHint', { v: '25,3' })
function t(key, vars = {}) {
  const s = (I18N[S.lang] && I18N[S.lang][key]) ?? I18N.vi[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}
// Chuỗi từ file cấu hình: chuỗi thường hoặc { vi, ja }
const L = v => (v && typeof v === 'object' ? v[S.lang] ?? v.vi ?? Object.values(v)[0] : v);
const num = (v, d = 1) => (typeof v === 'number' ? (S.lang === 'vi' ? v.toFixed(d).replace('.', ',') : v.toFixed(d)) : '—');
const time = ts => new Date(ts).toLocaleTimeString(t('locale'), { hour12: false });

function pickLang() {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem('bms-lang');
    if (LANGS.includes(saved)) return saved;
  } catch { /* trình duyệt chặn localStorage: bỏ qua */ }
  return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'vi';
}

function applyStatic() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  const sw = $('#lang-switch');
  sw.setAttribute('aria-label', t('lang.label'));
  sw.innerHTML = LANGS.map(l => `<button type="button" lang="${l}" data-lang="${l}" aria-pressed="${l === S.lang}">${esc(I18N[l]['lang.name'])}</button>`).join('');
  const range = $('#trend-range');
  const cur = range.value || '15';
  range.innerHTML = [5, 15, 60, 360]
    .map(m => `<option value="${m}">${m < 60 ? t('trend.min', { n: m }) : t('trend.hour', { n: m / 60 })}</option>`)
    .join('');
  range.value = cur;
  if (S.cfg) $('#site-name').textContent = `BMS Demo · ${L(S.cfg.site.name)}`;
}

function setLang(lang) {
  if (!LANGS.includes(lang) || lang === S.lang) return;
  S.lang = lang;
  try { localStorage.setItem('bms-lang', lang); } catch { /* bỏ qua */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', lang);
  window.history.replaceState(null, '', url);
  applyStatic();
  buildFloor();
  buildTrendSelect();
  S.lastAlarmSig = '';
  render();
  loadTrend();
  loadFaults();
  if (S.tab === 'log') loadEvents();
}

/* ---------- Định dạng giá trị ---------- */
function tempClass(v) {
  if (typeof v !== 'number') return 't-off';
  if (v < 18) return 't-cool';
  if (v <= 27) return 't-ok';
  if (v <= 32) return 't-warn';
  return 't-crit';
}

function fmtPoint(id) {
  const m = S.meta[id] || {};
  const v = val(id);
  if (v === undefined) return '—';
  if (m.enum) return L(m.enum[String(v)]) || String(v);
  const decimals = id === 'site.pue' ? 2 : m.uom && m.uom !== '%' ? 1 : 0;
  return `${num(v, decimals)}${m.uom ? ` ${m.uom}` : ''}`;
}

const alarmText = a => (a.messages && a.messages[S.lang]) || a.message;

/* ---------- KPI ---------- */
function renderKpis() {
  const alarms = S.snap.alarms || [];
  const activeCrit = alarms.filter(a => !a.clearedAt && a.severity === 'critical').length;
  const active = alarms.filter(a => !a.clearedAt).length;
  const inletMax = val('site.inlet_max');
  const pue = val('site.pue');
  const items = [
    { k: 'PUE', v: num(pue, 2), h: t('kpi.pueHint'), cls: pue > 1.6 ? 'warn' : '' },
    { k: t('kpi.it'), v: num(val('pm1.it_kw')), u: 'kW', h: t('kpi.itHint') },
    { k: t('kpi.cooling'), v: num(val('site.cooling_kw')), u: 'kW', h: t('kpi.coolingHint') },
    { k: t('kpi.inlet'), v: num(inletMax), u: '°C', h: t('kpi.inletHint', { v: num(val('site.inlet_avg')) }),
      cls: inletMax > 32 ? 'crit' : inletMax > 27 ? 'warn' : '' },
    { k: t('kpi.alarms'), v: String(active), h: t('kpi.alarmsHint', { n: activeCrit }), cls: activeCrit ? 'crit' : active ? 'warn' : '' },
  ];
  $('#kpis').innerHTML = items
    .map(i => `<div class="kpi ${i.cls || ''}"><div class="k">${esc(i.k)}</div><div class="v">${i.v}${i.u ? `<small>${i.u}</small>` : ''}</div><div class="h">${esc(i.h)}</div></div>`)
    .join('');
}

/* ---------- Sơ đồ phòng máy (SVG) ---------- */
function buildFloor() {
  const racks = S.cfg.devices.filter(d => d.type === 'rack_sensor').sort((a, b) => a.position - b.position);
  const rw = 100, gap = 12, x0 = 160;
  let svg = `<rect class="aisle" x="${x0 - 10}" y="18" width="${racks.length * (rw + gap) + 8}" height="22" rx="4"/>
    <text class="lbl" x="${x0}" y="34">${esc(t('floor.aisle'))}</text>`;
  racks.forEach((r, i) => {
    const x = x0 + i * (rw + gap);
    svg += `<rect id="rk-${r.id}" class="rack t-off" x="${x}" y="50" width="${rw}" height="110" rx="6"/>
      <text class="on-dark" x="${x + 10}" y="72">R${r.position}</text>
      <text id="rkt-${r.id}" class="big" x="${x + 10}" y="110">—</text>
      <text id="rkh-${r.id}" class="on-dark" x="${x + 10}" y="145">—</text>`;
  });
  const crahs = S.cfg.devices.filter(d => d.type === 'crah');
  const xEnd = x0 + racks.length * (rw + gap) + 10;
  crahs.forEach((c, i) => {
    const x = i === 0 ? 20 : xEnd;
    svg += `<rect class="unit" x="${x}" y="50" width="120" height="110" rx="6"/>
      <circle id="cs-${c.id}" class="st-off" cx="${x + 104}" cy="66" r="7"/>
      <text x="${x + 12}" y="72" font-weight="600">${esc(L(c.name))}</text>
      <text class="lbl" x="${x + 12}" y="98">${esc(t('floor.fan'))}</text><text id="cf-${c.id}" x="${x + 60}" y="98">—</text>
      <text class="lbl" x="${x + 12}" y="122">${esc(t('floor.supply'))}</text><text id="ct-${c.id}" x="${x + 60}" y="122">—</text>
      <text class="lbl" x="${x + 12}" y="146">${esc(t('floor.power'))}</text><text id="ck-${c.id}" x="${x + 60}" y="146">—</text>`;
  });
  const zw = (racks.length * (rw + gap) - gap) / 3;
  [1, 2, 3].forEach((z, i) => {
    svg += `<rect id="zone-${z}" class="zone" x="${x0 + i * zw}" y="180" width="${zw - 6}" height="18" rx="4"/>
      <text class="lbl" x="${x0 + i * zw + 8}" y="194">${esc(t('floor.zone', { n: z }))}</text>`;
  });
  svg += `<text class="lbl" x="${x0}" y="222">${esc(t('floor.leakCable'))}</text>
    <text id="chiller-line" class="lbl" x="20" y="244"></text>`;
  $('#floor').setAttribute('viewBox', `0 0 ${xEnd + 140} 252`);
  $('#floor').innerHTML = svg;
}

function renderFloor() {
  const devs = S.snap.devices || {};
  for (const r of S.cfg.devices.filter(d => d.type === 'rack_sensor')) {
    const v = val(`${r.id}.temp`);
    const online = devs[r.id] && devs[r.id].status === 'online';
    $(`#rk-${r.id}`).setAttribute('class', `rack ${online ? tempClass(v) : 't-off'}`);
    $(`#rkt-${r.id}`).textContent = online ? `${num(v)}°C` : '—';
    $(`#rkh-${r.id}`).textContent = online ? `${num(val(`${r.id}.humidity`), 0)} %RH` : t('floor.noSignal');
  }
  for (const c of S.cfg.devices.filter(d => d.type === 'crah')) {
    const st = val(`${c.id}.status`);
    $(`#cs-${c.id}`).setAttribute('class', st === 1 ? 'st-run' : st === 2 ? 'st-fault' : 'st-off');
    $(`#cf-${c.id}`).textContent = fmtPoint(`${c.id}.fan_speed`);
    $(`#ct-${c.id}`).textContent = fmtPoint(`${c.id}.supply_temp`);
    $(`#ck-${c.id}`).textContent = fmtPoint(`${c.id}.power_kw`);
  }
  const leakZone = val('leak1.detected') === 1 ? val('leak1.zone') : 0;
  [1, 2, 3].forEach(z => $(`#zone-${z}`).setAttribute('class', `zone${leakZone === z ? ' leak' : ''}`));
  const ch = S.cfg.devices.find(d => d.type === 'chiller');
  if (ch) {
    $('#chiller-line').textContent = t('floor.chiller', {
      name: L(ch.name), status: fmtPoint(`${ch.id}.status`), s: fmtPoint(`${ch.id}.chw_supply`),
      r: fmtPoint(`${ch.id}.chw_return`), l: fmtPoint(`${ch.id}.load_pct`),
    });
  }
}

/* ---------- Cảnh báo ---------- */
function renderAlarms() {
  const list = S.snap.alarms || [];
  const active = list.filter(a => !a.clearedAt).length;
  const cnt = $('#alarm-count');
  cnt.textContent = String(list.length);
  cnt.className = `count${active ? ' hot' : ''}`;
  const sig = JSON.stringify(list.map(a => [a.id, a.clearedAt, a.ackedAt, a.value]));
  if (sig === S.lastAlarmSig) return;
  S.lastAlarmSig = sig;
  $('#alarms').innerHTML = list.length
    ? list
        .map(a => {
          const state = a.clearedAt ? t('alarms.clearedAt', { t: time(a.clearedAt) }) : t('alarms.active');
          const ack = a.ackedAt ? t('alarms.ackedBy', { u: a.ackedBy }) : '';
          return `<div class="alarm ${a.clearedAt ? 'cleared' : 'active'} ${a.ackedAt ? 'acked' : 'unacked'}">
            <span class="sev ${a.severity}">${esc(t(`sev.${a.severity}`))}</span>
            <div><div class="msg">${esc(alarmText(a))}</div><div class="meta">${time(a.raisedAt)} · ${esc(state)}${ack ? ` · ${esc(ack)}` : ''}</div></div>
            ${a.ackedAt ? '' : `<button class="btn" data-ack="${a.id}">${esc(t('alarms.ack'))}</button>`}
          </div>`;
        })
        .join('')
    : `<div class="empty">${esc(t('alarms.empty'))}</div>`;
  if (S.tab === 'log') loadEvents();
}

async function loadEvents() {
  const ev = await (await fetch('/api/events?limit=100')).json();
  $('#events').innerHTML = ev.length
    ? ev.map(e => `<div class="ev"><span class="muted">${time(e.ts)}</span><span>${esc(t(`event.${e.type}`))}</span><span>${esc(alarmText(e.alarm))}</span></div>`).join('')
    : `<div class="empty">${esc(t('events.empty'))}</div>`;
}

/* ---------- Bảng thiết bị ---------- */
function renderDevices() {
  const devs = S.snap.devices || {};
  const rows = S.cfg.devices
    .map(d => {
      const st = devs[d.id] || { status: 'unknown' };
      const vals = d.points.map(p => `<span>${esc(L(p.name))}: <b>${esc(fmtPoint(`${d.id}.${p.key}`))}</b></span>`).join('');
      return `<tr><td><b>${esc(L(d.name))}</b><div class="muted small">unit ${d.unit}</div></td>
        <td><span class="pill ${st.status}">${esc(t(`devices.${st.status}`))}</span>${st.error ? `<div class="muted small">${esc(st.error)}</div>` : ''}</td>
        <td><div class="vals">${st.status === 'online' ? vals : `<span class="muted">${esc(t('devices.noData'))}</span>`}</div></td></tr>`;
    })
    .join('');
  $('#devices').innerHTML = `<thead><tr><th>${esc(t('devices.colDevice'))}</th><th>${esc(t('devices.colConn'))}</th><th>${esc(t('devices.colValues'))}</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ---------- Biểu đồ xu hướng (canvas) ---------- */
function thresholdsFor(point) {
  return S.cfg.rules
    .filter(r => r.point && r.op !== '==' && new RegExp(`^${r.point.replace(/[.]/g, '\\.').replace(/\*/g, '[^.]*')}$`).test(point))
    .map(r => ({ v: r.value, sev: r.severity }));
}

async function loadTrend() {
  const point = $('#trend-point').value;
  const minutes = Number($('#trend-range').value);
  const data = await (await fetch(`/api/history?point=${encodeURIComponent(point)}&minutes=${minutes}`)).json();
  drawTrend(data.rows || [], data.meta || {}, thresholdsFor(point), minutes);
}

function drawTrend(rows, meta, ths, minutes) {
  const c = $('#trend');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 260;
  c.width = w * dpr; c.height = h * dpr; c.style.height = `${h}px`;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const now = Date.now(), t0 = now - minutes * 60000;
  const vs = rows.map(r => r[1]).concat(ths.map(x => x.v));
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (!rows.length) { lo = 0; hi = 1; }
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
  const X = ts => pad.l + ((ts - t0) / (now - t0)) * (w - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  g.font = '12px system-ui, sans-serif';
  g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4, y = Y(v);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.fillText(num(v, span < 5 ? 1 : 0), 6, y + 4);
  }
  for (let i = 0; i <= 4; i++) {
    const ts = t0 + ((now - t0) * i) / 4;
    const label = new Date(ts).toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit', hour12: false });
    g.fillText(label, Math.min(X(ts) - 16, w - 40), h - 8);
  }
  for (const th of ths) {
    g.strokeStyle = css(th.sev === 'critical' ? '--crit' : th.sev === 'warning' ? '--warn' : '--info');
    g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(pad.l, Y(th.v)); g.lineTo(w - pad.r, Y(th.v)); g.stroke();
    g.setLineDash([]);
  }
  g.strokeStyle = css('--accent'); g.lineWidth = 2;
  g.beginPath();
  let prev = null;
  rows.forEach(([ts, v]) => {
    // ngắt đường khi mất dữ liệu (> 3 chu kỳ đọc) thay vì nối thẳng
    if (prev === null || ts - prev > S.cfg.pollIntervalMs * 3) g.moveTo(X(ts), Y(v));
    else g.lineTo(X(ts), Y(v));
    prev = ts;
  });
  g.stroke();
  const lastV = rows.length ? rows[rows.length - 1][1] : undefined;
  $('#trend-note').textContent = rows.length
    ? t('trend.note', { name: L(meta.name), v: num(lastV, 2), u: meta.uom || '', n: rows.length })
    : t('trend.empty');
}

function buildTrendSelect() {
  const sel = $('#trend-point');
  const cur = sel.value || 'site.inlet_max';
  const opts = [];
  for (const p of S.cfg.derived) opts.push([p.id, `${t('trend.site')} · ${L(p.name)}`]);
  for (const d of S.cfg.devices) for (const p of d.points) if (!p.enum && p.key !== 'zone') opts.push([`${d.id}.${p.key}`, `${L(d.name)} · ${L(p.name)}`]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  sel.value = cur;
}

/* ---------- Bảng giả lập sự cố (gọi API của bộ giả lập, không qua BMS) ---------- */
async function loadFaults(method = 'GET', body) {
  try {
    const res = await fetch(`${S.simUrl}/api/faults`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    const { faults } = await res.json();
    $('#faults').innerHTML = faults
      .map(f => `<label class="fault ${f.active ? 'on' : ''}"><input type="checkbox" data-fault="${f.id}" ${f.active ? 'checked' : ''}>${esc(L(f.label))}</label>`)
      .join('');
  } catch {
    $('#faults').innerHTML = `<div class="empty">${esc(t('sim.unreachable', { url: S.simUrl }))}</div>`;
  }
}

/* ---------- Khởi động ---------- */
function render() {
  if (!S.snap || !S.snap.values) return;
  renderKpis(); renderFloor(); renderAlarms(); renderDevices();
}

function connect() {
  const es = new EventSource('/api/stream');
  const setConn = (cls, key) => { $('#conn-dot').className = `dot ${cls}`; const el = $('#conn-text'); el.dataset.i18n = key; el.textContent = t(key); };
  es.onopen = () => setConn('on', 'conn.live');
  es.onmessage = e => { S.snap = JSON.parse(e.data); render(); };
  es.onerror = () => setConn('err', 'conn.lost');
}

async function init() {
  S.lang = pickLang();
  applyStatic();
  S.cfg = await (await fetch('/api/config')).json();
  // Deploy một cổng (SIM_PROXY=1): gọi bộ giả lập qua /sim trên cùng domain; chạy local: gọi thẳng cổng 5021
  S.simUrl = S.cfg.simControlPath || `${location.protocol}//${location.hostname}:${S.cfg.simControlPort}`;
  for (const d of S.cfg.devices) for (const p of d.points) S.meta[`${d.id}.${p.key}`] = { name: p.name, uom: p.uom || '', enum: p.enum };
  for (const p of S.cfg.derived) S.meta[p.id] = { name: p.name, uom: p.uom };
  applyStatic();
  buildFloor(); buildTrendSelect(); connect(); loadTrend(); loadFaults();
  setInterval(loadTrend, 5000);
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(t('locale'), { hour12: false }); }, 1000);
  window.addEventListener('resize', loadTrend);

  document.addEventListener('click', async e => {
    const lang = e.target.closest('[data-lang]');
    if (lang) { setLang(lang.dataset.lang); return; }
    const ack = e.target.closest('[data-ack]');
    if (ack) {
      ack.disabled = true;
      await fetch(`/api/alarms/${ack.dataset.ack}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'operator' }) });
      S.snap.alarms = await (await fetch('/api/alarms')).json();
      render();
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      S.tab = tab.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b === tab)));
      $('#alarms').hidden = S.tab !== 'active';
      $('#events').hidden = S.tab !== 'log';
      if (S.tab === 'log') loadEvents();
    }
  });
  $('#faults').addEventListener('change', e => {
    const box = e.target.closest('[data-fault]');
    if (box) loadFaults('POST', { id: box.dataset.fault, active: box.checked });
  });
  $('#trend-point').addEventListener('change', loadTrend);
  $('#trend-range').addEventListener('change', loadTrend);
}

init();

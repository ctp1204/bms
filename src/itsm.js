'use strict';
// Bộ nối cảnh báo → ticket iTop. Quy tắc lấy từ config/itsm.json (thiết kế ở Giai đoạn 0):
// - Gom cảnh báo theo nhóm sự cố: cảnh báo đầu tiên mở ticket; các cảnh báo sau chỉ thêm ghi chú,
//   gắn thêm CI và nâng ưu tiên nếu nặng hơn. Không tự hạ ưu tiên, không tự đóng ticket.
// - Cảnh báo warning chỉ mở ticket nếu còn sau warningHoldSec; nếu nhóm đã có ticket thì ghi chú ngay.
// - Mọi lệnh gửi iTop đi qua một hàng đợi tuần tự, lưu xuống đĩa. iTop lỗi đường truyền thì thử lại,
//   bộ cảnh báo không bao giờ phải chờ iTop.
// - Tùy chọn impact(alarm): trả về { vi: [dòng], ja: [dòng], cis: [mã CI] } để ghi thêm phần "ảnh hưởng"
//   vào ticket và gắn thêm CI (vd. máy chủ chỉ còn một nguồn khi mất PDU, lấy từ DCIM). Trả null nếu không liên quan.

const fs = require('fs');
const { EventEmitter } = require('events');
const { ItopError, oqlString } = require('./itop');
const { loc } = require('./locale');

const RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
const CLOSED = new Set(['resolved', 'closed']);
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;
const TITLE_MAX = 200;
const SKIPPED = Symbol('skipped');
const VIEW_BY_TEAM = { power: 'power', cooling: 'cooling' };

// Thử lại khi lỗi đường truyền, iTop quá tải, hoặc sai đăng nhập (sửa .env rồi khởi động lại là gửi tiếp).
// Lỗi nghiệp vụ khác của iTop (mã số) thì thử lại cũng vô ích: bỏ lệnh đó, ghi lỗi.
const AUTH_CODES = new Set([1, 5, 6]);
const retryable = e => !(e instanceof ItopError)
  || ['NETWORK', 'TIMEOUT', 'BAD_JSON'].includes(e.code) || /^HTTP_5/.test(String(e.code)) || AUTH_CODES.has(e.code);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const TX = {
  vi: {
    raised: 'Phát sinh thêm', cleared: 'Đã hết', acked: 'Đã xác nhận trên NOC bởi {user}', info: 'Thông tin',
    allCleared: 'Tất cả cảnh báo trong nhóm đã hết. Chờ người trực kiểm tra và đóng ticket.',
    escalated: 'Nâng ưu tiên lên {p}', group: 'Nhóm sự cố', team: 'Nhóm xử lý', priority: 'Ưu tiên',
    sla: 'SLA demo: phản hồi {tto}, xử lý {ttr}', alarms: 'Cảnh báo', prev: 'Tiếp nối ticket {ref} đã đóng.', impact: 'Ảnh hưởng',
    footer: 'Tạo tự động bởi BMS · EPMS Demo. Ticket không tự đóng.', min: 'phút', hour: 'giờ', day: 'ngày',
  },
  ja: {
    raised: '追加発生', cleared: '復旧', acked: 'NOC で {user} が確認', info: '情報',
    allCleared: 'グループ内のアラームはすべて復旧しました。担当者が確認してチケットをクローズしてください。',
    escalated: '優先度を {p} に引き上げ', group: '障害グループ', team: '担当チーム', priority: '優先度',
    sla: 'SLA（デモ）：応答 {tto}、解決 {ttr}', alarms: 'アラーム', prev: 'クローズ済みチケット {ref} の続き。', impact: '影響',
    footer: 'BMS · EPMS Demo が自動作成。チケットは自動でクローズされません。', min: '分', hour: '時間', day: '日',
  },
};
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const duration = (min, lang) => {
  const t = TX[lang];
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440} ${t.day}`;
  if (min >= 60 && min % 60 === 0) return `${min / 60} ${t.hour}`;
  return `${min} ${t.min}`;
};

class ItsmConnector extends EventEmitter {
  constructor({ client, config, devices = [], statePath = null, holdSec, nocUrl = '', itopUrl = '',
    timeZone = 'Asia/Ho_Chi_Minh', clock = Date.now, log = () => {}, impact = null }) {
    super();
    this.client = client;
    this.impact = impact;
    this.cfg = config;
    this.clock = clock;
    this.log = log;
    this.statePath = statePath;
    this.nocUrl = nocUrl;
    this.itopUrl = itopUrl && !itopUrl.endsWith('/') ? `${itopUrl}/` : itopUrl;
    this.holdMs = 1000 * (Number.isFinite(holdSec) ? holdSec : config.defaults.warningHoldSec);
    this.windowMs = 1000 * config.defaults.groupOpenAfterClearSec;
    this.knownDevices = new Set(devices.map(d => d.id));
    this.timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    this.dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

    this.rules = new Map();
    for (const g of config.groups) {
      for (const [ruleId, priority] of Object.entries(g.rules)) this.rules.set(ruleId, { group: g, priority });
      for (const ruleId of g.noteOnly || []) this.rules.set(ruleId, { group: g, noteOnly: true });
    }
    this.groups = {};
    this.outbox = [];
    this.seq = 0;
    this.health = { state: 'idle', lastError: null, lastOkAt: null };
    this.nextAttemptAt = 0;
    this.retryMs = RETRY_MIN_MS;
    this._pumping = null;
    this._load();
  }

  // ---------- Quyết định: chạy đồng bộ ngay khi có sự kiện cảnh báo ----------

  handle(e) {
    const a = e.alarm;
    const m = this.rules.get(a.ruleId);
    if (!m) return; // luật nằm trong "ignore" hoặc chưa ánh xạ
    const g = this._group(m.group, a);
    const now = e.ts;
    const hasTicket = g.state === 'open' || g.state === 'opening';

    if (m.noteOnly) {
      if (this._isOpen(g, now)) {
        if (e.type === 'raised') g.linked[a.key] = true; // để giao diện hiện link tới ticket đã ghi chú
        this._queue('note', g, { text: this._text(e.type === 'raised' ? 'info' : 'cleared', a, now) });
      }
    } else if (e.type === 'raised') {
      const open = this._isOpen(g, now); // xét trước khi thêm cảnh báo này vào nhóm
      g.active[a.key] = {
        ruleId: a.ruleId, severity: a.severity, priority: m.priority, raisedAt: now,
        deviceId: a.deviceId, point: a.point, value: a.value, messages: a.messages || a.message,
        impact: this._impactOf(a),
      };
      if (open) {
        const up = RANK[m.priority] < RANK[g.priority] ? m.priority : null;
        if (up) g.priority = up;
        const imp = g.active[a.key].impact;
        let ciAdded = this._addCi(g, a.deviceId);
        if (imp) for (const id of imp.cis) ciAdded = this._addCi(g, id, true) || ciAdded;
        g.linked[a.key] = true;
        this._queue('note', g, {
          kind: 'raised', text: this._text('raised', a, now) + (up ? `\n${fill(TX.vi.escalated, { p: up })} · ${fill(TX.ja.escalated, { p: up })}` : '')
            + (imp ? `\n${TX.vi.impact}:\n${imp.vi.join('\n')}\n${TX.ja.impact}：\n${imp.ja.join('\n')}` : ''),
          priority: up, cis: ciAdded ? [...g.cis] : null,
        });
      } else {
        this._maybeOpen(g, now);
      }
    } else if (e.type === 'cleared') {
      const had = g.active[a.key];
      delete g.active[a.key];
      if (had && hasTicket && g.linked[a.key]) {
        this._queue('note', g, { text: this._text('cleared', a, now) });
        if (Object.keys(g.active).length === 0) {
          g.lastClearedAt = now;
          const t = this._time(now);
          this._queue('note', g, { text: `[${t}] ${TX.vi.allCleared}\n[${t}] ${TX.ja.allCleared}` });
        }
      }
    } else if (e.type === 'acked') {
      if (hasTicket && g.linked[a.key]) this._queue('note', g, { text: this._text('acked', a, now) });
    }
    this._save();
  }

  // Gọi mỗi lượt đọc (2 giây): mở ticket cho warning đã chờ đủ lâu, gửi tiếp hàng đợi.
  tick(now = this.clock()) {
    for (const g of Object.values(this.groups)) if (!this._isOpen(g, now)) this._maybeOpen(g, now);
    this._pump();
  }

  flush() {
    return this._pump();
  }

  snapshot() {
    const tickets = {};
    for (const g of Object.values(this.groups)) {
      if (g.state !== 'open' || !g.ticket) continue;
      for (const k of Object.keys(g.linked)) tickets[k] = { ref: g.ticket.ref, url: this._ticketUrl(g.ticket.key) };
    }
    return { enabled: true, ...this.health, queue: this.outbox.length, tickets };
  }

  // ---------- Nhóm sự cố ----------

  _group(def, alarm) {
    const key = def.scope === 'device' ? `${def.id}:${alarm.deviceId}` : def.id;
    if (!this.groups[key]) {
      this.groups[key] = { key, groupId: def.id, state: null, ticket: null, priority: null, cis: [], active: {}, linked: {}, lastClearedAt: null, prevRef: null };
    }
    return this.groups[key];
  }

  _def(g) {
    return this.cfg.groups.find(x => x.id === g.groupId);
  }

  // Nhóm còn "mở" khi có ticket (hoặc đang tạo) và còn cảnh báo, hoặc chưa quá groupOpenAfterClearSec từ lúc hết.
  _isOpen(g, now) {
    if (g.state !== 'open' && g.state !== 'opening') return false;
    if (Object.keys(g.active).length) return true;
    return g.lastClearedAt !== null && now - g.lastClearedAt < this.windowMs;
  }

  // extra = CI đến từ phần ảnh hưởng (vd. máy chủ trong DCIM), không có trong devices.json
  _addCi(g, deviceId, extra = false) {
    if ((!extra && !this.knownDevices.has(deviceId)) || g.cis.includes(deviceId)) return false;
    g.cis.push(deviceId);
    return true;
  }

  _addImpactCis(g, list) {
    for (const x of list) if (x.impact) for (const id of x.impact.cis) this._addCi(g, id, true);
  }

  // Lỗi trong hook ảnh hưởng không được làm mất ticket
  _impactOf(a) {
    if (!this.impact) return null;
    try {
      const r = this.impact(a);
      return r && Array.isArray(r.vi) && Array.isArray(r.ja) ? { vi: r.vi, ja: r.ja, cis: r.cis || [] } : null;
    } catch (e) {
      this.log(`Bỏ qua phần ảnh hưởng (${e.message})`);
      return null;
    }
  }

  _maybeOpen(g, now) {
    const list = Object.entries(g.active).sort((x, y) => x[1].raisedAt - y[1].raisedAt);
    if (!list.length) return;
    const due = list.some(([, x]) => x.severity !== 'warning' || now - x.raisedAt >= this.holdMs);
    if (!due) return;
    g.prevRef = g.ticket ? g.ticket.ref : null;
    g.state = 'opening';
    g.ticket = null;
    g.lastClearedAt = null;
    g.cis = [];
    g.linked = {};
    for (const [k, x] of list) {
      this._addCi(g, x.deviceId);
      g.linked[k] = true;
    }
    this._addImpactCis(g, list.map(([, x]) => x));
    g.priority = list.map(([, x]) => x.priority).sort((p, q) => RANK[p] - RANK[q])[0];
    this._queue('open', g, this._openPayload(g, list.map(([, x]) => x)));
  }

  // ---------- Nội dung ticket ----------

  _time(ts) {
    return this.timeFmt.format(new Date(ts));
  }

  _msg(src, lang) {
    return loc(src, lang) || '';
  }

  _detail(x) {
    return x.point && typeof x.value === 'number' ? ` (${x.point} = ${x.value})` : '';
  }

  _text(kind, a, ts) {
    const t = this._time(ts);
    const vars = { user: a.ackedBy || 'operator' };
    const src = a.messages || a.message;
    return `[${t}] ${fill(TX.vi[kind], vars)}: ${this._msg(src, 'vi')}${this._detail(a)}\n[${t}] ${fill(TX.ja[kind], vars)}：${this._msg(src, 'ja')}`;
  }

  _openPayload(g, alarms) {
    const def = this._def(g);
    const team = this.cfg.teams[def.team];
    const pr = this.cfg.priorities[g.priority];
    const first = alarms[0];
    const title = `[${team.vi}] ${def.name.vi}: ${this._msg(first.messages, 'vi')}`;
    const block = lang => {
      const t = TX[lang];
      const items = alarms.map(x => `<li>${esc(this._time(x.raisedAt))} ${esc(this._msg(x.messages, lang))}${esc(this._detail(x))}</li>`).join('');
      const sla = fill(t.sla, { tto: duration(pr.ttoMin, lang), ttr: duration(pr.ttrMin, lang) });
      return `<p><b>${t.group}:</b> ${esc(def.name[lang])} · <b>${t.team}:</b> ${esc(team[lang])} · `
        + `<b>${t.priority}:</b> ${g.priority} ${esc(pr.name[lang])} (${esc(sla)})</p>`
        + `<p><b>${t.alarms}:</b></p><ul>${items}</ul>`
        + alarms.filter(x => x.impact).map(x => `<p><b>${t.impact}:</b></p><ul>${x.impact[lang].map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')
        + (g.prevRef ? `<p>${esc(fill(t.prev, { ref: g.prevRef }))}</p>` : '');
    };
    const view = VIEW_BY_TEAM[def.team] || 'overview';
    const noc = this.nocUrl ? `<p>NOC: <a href="${esc(`${this.nocUrl}#${view}`)}">${esc(`${this.nocUrl}#${view}`)}</a></p>` : '';
    return {
      title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
      description: `${block('vi')}${noc}<hr>${block('ja')}<p><i>${esc(TX.vi.footer)} ${esc(TX.ja.footer)}</i></p>`,
      priority: g.priority,
      team: team.itop,
      cis: [...g.cis],
    };
  }

  _ciLinks(deviceIds) {
    return deviceIds.map(id => ({ functionalci_id: `SELECT PhysicalDevice WHERE asset_number = ${oqlString(this.cfg.cmdb.assetPrefix + id)}` }));
  }

  _ticketUrl(key) {
    return this.itopUrl ? `${this.itopUrl}pages/UI.php?operation=details&class=Incident&id=${key}` : null;
  }

  // ---------- Hàng đợi gửi iTop ----------

  _queue(op, g, data) {
    this.outbox.push({ id: ++this.seq, op, groupKey: g.key, ...data });
    this._save();
    this._pump();
  }

  // Một vòng gửi tại một thời điểm. Lệnh xếp hàng trong lúc vòng đang chạy (kể cả lúc vòng vừa xong
  // nhưng chưa kịp kết thúc) sẽ được gửi ở vòng kế tiếp ngay sau đó, không phải chờ tới lượt tick sau.
  _pump() {
    if (this._pumping) {
      this._again = true;
      return this._pumping;
    }
    this._pumping = (async () => {
      do {
        this._again = false;
        await this._drain();
      } while (this._again && this.outbox.length && this.clock() >= this.nextAttemptAt);
    })().finally(() => { this._pumping = null; });
    return this._pumping;
  }

  async _drain() {
    while (this.outbox.length && this.clock() >= this.nextAttemptAt) {
      const job = this.outbox[0];
      try {
        const sent = await this._run(job);
        this.outbox.shift();
        // Lệnh bị bỏ qua mà không gọi iTop không chứng minh được iTop ổn: giữ nguyên trạng thái lỗi trước đó.
        if (sent !== SKIPPED) {
          this.retryMs = RETRY_MIN_MS;
          this.health = { state: 'ok', lastError: null, lastOkAt: this.clock() };
        }
      } catch (e) {
        if (retryable(e)) {
          this.nextAttemptAt = this.clock() + this.retryMs;
          this.log(`iTop lỗi (${e.message}), thử lại sau ${this.retryMs / 1000} s. Còn ${this.outbox.length} lệnh chờ.`);
          this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
          this.health = { ...this.health, state: 'retrying', lastError: e.message };
          this._save();
          break;
        }
        this.outbox.shift();
        const g = this.groups[job.groupKey];
        if (job.op === 'open' && g && g.state === 'opening') g.state = 'failed';
        this.health = { ...this.health, state: 'error', lastError: e.message };
        this.log(`Bỏ lệnh ${job.op} cho ${job.groupKey}: ${e.message}`);
      }
      this._save();
    }
  }

  async _run(job) {
    const g = this.groups[job.groupKey];
    if (!g) return SKIPPED;
    if (job.op === 'open') return this._create(g, job);
    if (!g.ticket) return SKIPPED; // ticket của nhóm không tạo được: bỏ ghi chú
    if (job.kind === 'raised') {
      // Người trực đã đóng ticket trong lúc cảnh báo phát sinh lại: mở ticket mới, ghi tham chiếu ticket cũ.
      const [cur] = await this.client.get('Incident', g.ticket.key, 'status');
      if (cur && CLOSED.has(cur.fields.status)) {
        const list = Object.values(g.active).sort((x, y) => x.raisedAt - y.raisedAt);
        if (!list.length) return undefined; // cảnh báo đã hết trước khi kịp gửi: không cần ticket mới (đã gọi iTop)
        g.prevRef = g.ticket.ref;
        g.cis = [];
        for (const x of list) this._addCi(g, x.deviceId);
        this._addImpactCis(g, list);
        g.priority = list.map(x => x.priority).sort((p, q) => RANK[p] - RANK[q])[0];
        g.linked = Object.fromEntries(Object.keys(g.active).map(k => [k, true]));
        g.lastClearedAt = null;
        return this._create(g, this._openPayload(g, list));
      }
    }
    const fields = { public_log: { add_item: { message: job.text, format: 'text' } } };
    if (job.priority) Object.assign(fields, this._priorityFields(job.priority));
    if (job.cis) fields.functionalcis_list = this._ciLinks(job.cis); // ghi đè cả danh sách, nên gửi đủ CI
    try {
      await this.client.update('Incident', g.ticket.key, fields, { comment: 'bms-itsm' });
    } catch (e) {
      if (retryable(e) || !job.cis) throw e;
      // Giống lúc tạo ticket: CI chưa có trong CMDB thì vẫn ghi chú, chỉ không gắn CI.
      this.log(`Không gắn được CI (${e.message}). Ghi chú không kèm CI; chạy npm run itsm:cmdb để đồng bộ CMDB.`);
      delete fields.functionalcis_list;
      await this.client.update('Incident', g.ticket.key, fields, { comment: 'bms-itsm' });
    }
  }

  _priorityFields(p) {
    const { impact, urgency } = this.cfg.priorities[p].itop;
    return { impact: String(impact), urgency: String(urgency) };
  }

  async _create(g, job) {
    const { itop, defaults } = this.cfg;
    const fields = {
      org_id: `SELECT Organization WHERE name = ${oqlString(itop.organization)}`,
      caller_id: `SELECT Person WHERE name = ${oqlString(itop.callerLastName)} AND first_name = ${oqlString(itop.callerFirstName)}`,
      team_id: `SELECT Team WHERE name = ${oqlString(job.team)}`,
      title: job.title,
      description: job.description,
      origin: defaults.origin,
      ...this._priorityFields(job.priority),
    };
    let o;
    try {
      o = await this.client.create(defaults.ticketClass, { ...fields, functionalcis_list: this._ciLinks(job.cis) }, { comment: 'bms-itsm', outputFields: 'ref' });
    } catch (e) {
      if (retryable(e) || !job.cis.length) throw e;
      // Thường là CI chưa có trong CMDB (chưa chạy npm run itsm:cmdb): vẫn tạo ticket, chỉ không gắn CI.
      this.log(`Không gắn được CI (${e.message}). Tạo ticket không có CI; chạy npm run itsm:cmdb để đồng bộ CMDB.`);
      o = await this.client.create(defaults.ticketClass, fields, { comment: 'bms-itsm', outputFields: 'ref' });
    }
    g.ticket = { key: o.key, ref: o.fields.ref };
    g.state = 'open';
    this.log(`Đã tạo ${o.fields.ref} [${job.priority}] ${job.title}`);
    this.emit('ticket', { group: g.key, ref: o.fields.ref, key: o.key, priority: job.priority });
  }

  // ---------- Lưu trạng thái ----------

  _save() {
    if (!this.statePath) return;
    const groups = Object.fromEntries(Object.values(this.groups).map(g => {
      const { active, ...rest } = g;
      return [g.key, { ...rest, hadActive: Object.keys(active).length > 0 }];
    }));
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, seq: this.seq, groups, outbox: this.outbox }));
    fs.renameSync(tmp, this.statePath);
  }

  _load() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    let s;
    try {
      s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (e) {
      this.log(`Không đọc được ${this.statePath} (${e.message}); bắt đầu trạng thái mới.`);
      return;
    }
    const now = this.clock();
    this.seq = s.seq || 0;
    this.outbox = s.outbox || [];
    for (const [key, g] of Object.entries(s.groups || {})) {
      const { hadActive, ...rest } = g;
      // Sau khởi động lại bộ cảnh báo sẽ phát sinh lại các cảnh báo còn đúng: giữ nhóm "mở" thêm một khoảng
      // để chúng thành ghi chú trên ticket cũ thay vì mở ticket trùng.
      this.groups[key] = { ...rest, active: {}, lastClearedAt: hadActive ? now : rest.lastClearedAt };
    }
  }
}

module.exports = { ItsmConnector, retryable };

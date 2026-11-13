'use strict';
// Phân tích ảnh hưởng khi mất một PDU sàn, dựa trên đường cấp điện trong hồ sơ DCIM (NetBox):
// - máy chủ mất điện hẳn (mọi nguồn đều đi qua PDU bị mất, hoặc nguồn còn lại không lần được tới tủ nào);
// - máy chủ chỉ còn một nguồn (mất dự phòng);
// - feed còn lại của mỗi rack phải gánh toàn bộ các máy còn điện (theo công suất định mức) so với công suất khả dụng.
// Dùng cho ticket iTop khi có cảnh báo pdu_input_lost.

const round1 = x => Math.round(x * 10) / 10;

function feedAvailableKw(dcim) {
  const f = dcim.power.feed;
  const phases = f.phase === 'three-phase' ? Math.sqrt(3) : 1;
  return (phases * f.voltage * f.amperage * f.maxUtilization / 100) / 1000;
}

// inventory: kết quả inventoryFromNetbox / inventoryFromConfig (có devices[].sources). pduId: 'pdua' | 'pdub'.
function powerImpact(inventory, dcim, pduId) {
  const feed = dcim.power.feeds.find(f => f.pdu === pduId);
  if (!feed) return null;
  const lost = feed.side;
  const available = feedAvailableKw(dcim);
  const singleSourced = [];
  const unpowered = [];
  const loadByFeed = {};
  for (const r of inventory.racks) {
    for (const d of r.devices) {
      const alive = (d.sources || []).filter(s => s.side && s.side !== lost);
      if (alive.length === 0) unpowered.push({ name: d.name, rack: r.name });
      else if (alive.length === 1) singleSourced.push({ name: d.name, rack: r.name, feed: alive[0].feed });
      // Mỗi nguồn còn lại phải chịu được cả máy: cộng công suất định mức vào từng feed còn sống của máy đó
      for (const s of alive) {
        const k = s.feed;
        loadByFeed[k] = loadByFeed[k] || { feed: k, rack: r.name, kw: 0 };
        loadByFeed[k].kw += d.ratedKw;
      }
    }
  }
  const feeds = Object.values(loadByFeed)
    .map(x => ({ ...x, kw: round1(x.kw), availableKw: round1(available), pct: Math.round((x.kw / available) * 100), over: x.kw > available }))
    .sort((a, b) => b.pct - a.pct);
  return { pdu: pduId, side: lost, singleSourced, unpowered, feeds };
}

const TX = {
  vi: {
    head: 'Ảnh hưởng theo hồ sơ DCIM ({src}): mất PDU phía {side}.',
    noneDown: 'Mất điện hẳn: không có máy chủ nào.',
    down: 'MẤT ĐIỆN HẲN: {n} máy chủ: {list}.',
    single: 'Chỉ còn một nguồn (mất dự phòng): {n} máy chủ. {list}.',
    feeds: 'Feed còn lại phải gánh cả rack (định mức / khả dụng {a} kW): {list}.',
    over: 'QUÁ TẢI',
  },
  ja: {
    head: 'DCIM 台帳（{src}）による影響：{side} 系 PDU の喪失。',
    noneDown: '完全停電：該当サーバーなし。',
    down: '完全停電：{n} 台：{list}。',
    single: '片系給電のみ（冗長性喪失）：{n} 台。{list}。',
    feeds: '残りのフィードがラック全体を負担（定格 / 供給可能 {a} kW）：{list}。',
    over: '過負荷',
  },
};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]);

// Văn bản ngắn cho ticket, theo từng ngôn ngữ: mảng các dòng. Máy chủ gom theo rack cho dễ đọc.
function impactLines(impact, lang, sourceName) {
  const t = TX[lang];
  const num = v => (lang === 'vi' ? String(v).replace('.', ',') : String(v));
  const byRack = list => {
    const m = new Map();
    for (const x of list) m.set(x.rack, [...(m.get(x.rack) || []), x.name]);
    return [...m].map(([rack, names]) => `${rack}: ${names.join(', ')}`).join('; ');
  };
  const lines = [fill(t.head, { src: sourceName, side: impact.side })];
  lines.push(impact.unpowered.length ? fill(t.down, { n: impact.unpowered.length, list: byRack(impact.unpowered) }) : t.noneDown);
  if (impact.singleSourced.length) lines.push(fill(t.single, { n: impact.singleSourced.length, list: byRack(impact.singleSourced) }));
  if (impact.feeds.length) {
    lines.push(fill(t.feeds, {
      a: num(impact.feeds[0].availableKw),
      list: impact.feeds.map(f => `${f.feed} ${num(f.kw)} kW (${f.pct}%)${f.over ? ` ${t.over}` : ''}`).join(', '),
    }));
  }
  return lines;
}

module.exports = { powerImpact, impactLines, feedAvailableKw };

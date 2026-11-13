'use strict';
// Dung lượng DCIM: hồ sơ (rack, thiết bị, vị trí U, công suất định mức) + số đo thật (EPMS, BMS)
// → còn bao nhiêu U, bao nhiêu kW, bao nhiêu độ nhiệt cho mỗi rack; PDU sàn còn cách ngưỡng 2N bao xa;
// và "lắp thiết bị X vào đâu".
// Hồ sơ lấy từ NetBox (nguồn gốc). Không có NetBox thì dùng config/dcim.json (cùng dữ liệu đã đồng bộ).

const realKeys = o => Object.entries(o).filter(([k]) => !k.startsWith('$'));
const round = (x, d = 1) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Hồ sơ từ config: [{ id:'rack1', name:'R1', uHeight, devices:[{ name, type, u, position, ratedKw, sources }] }]
// sources: đường cấp điện của từng nguồn (PSU) — [{ psu, side, rpdu, outlet, feed }], theo cách dcim:sync đi dây:
// PSU1 → thanh nguồn A, PSU2 → thanh nguồn B, cùng số ổ cắm (thứ tự máy trong rack).
function inventoryFromConfig(dcim, devices) {
  const byId = Object.fromEntries(devices.map(d => [d.id, d]));
  return {
    source: 'config',
    racks: dcim.racks.map(r => {
      const R = `R${byId[r.rack].position}`;
      return {
        id: r.rack,
        name: R,
        uHeight: dcim.rack.uHeight,
        devices: r.devices.map((d, i) => {
          const t = dcim.deviceTypes[d.type];
          const sources = dcim.power.feeds.slice(0, t.psu || 0).map(({ side }, k) => ({
            psu: `PSU${k + 1}`, side, rpdu: `${R}-RPDU-${side}`, outlet: `Outlet ${i + 1}`, feed: `${R}-${side}`,
          }));
          return { name: d.name, type: d.type, u: t.u, position: d.position, ratedKw: t.ratedKw, sources };
        }),
      };
    }),
  };
}

// Hồ sơ từ NetBox: rack có facility_id = keyPrefix + id; thiết bị trong rack có vị trí U.
// Công suất định mức = maximum_draw lớn nhất trong các PSU (mỗi PSU chịu được cả máy).
// Thiết bị 0U (thanh nguồn) không chiếm U và không tính tải.
// Đường cấp điện lần theo cáp thật: PSU → ổ cắm thanh nguồn → cổng Input của thanh → power feed → tủ PDU.
// Nguồn chưa cắm cáp thì không có trong sources; chuỗi đứt giữa chừng thì side = null.
async function inventoryFromNetbox(client, dcim, devices) {
  const nb = dcim.netbox;
  const [site] = await client.list('dcim/sites/', { slug: nb.siteSlug });
  if (!site) throw new Error(`NetBox chưa có site ${nb.siteSlug}. Chạy npm run dcim:sync.`);
  const [racks, devs, types, ports, outlets, feeds, panels] = await Promise.all([
    client.list('dcim/racks/', { site_id: site.id }),
    client.list('dcim/devices/', { site_id: site.id }),
    client.list('dcim/device-types/'),
    client.list('dcim/power-ports/', { site_id: site.id }),
    client.list('dcim/power-outlets/', { site_id: site.id }),
    client.list('dcim/power-feeds/', { site_id: site.id }),
    client.list('dcim/power-panels/', { site_id: site.id }),
  ]);
  const devName = Object.fromEntries(devs.map(d => [d.id, d.name]));
  const portById = Object.fromEntries(ports.map(p => [p.id, p]));
  const outletById = Object.fromEntries(outlets.map(o => [o.id, o]));
  const feedById = Object.fromEntries(feeds.map(f => [f.id, f]));
  // Tủ PDU sàn → phía A/B, theo tên thiết bị PDU trong devices.json (dcim:sync đặt tên tủ như vậy)
  const pduName = id => { const d = devices.find(x => x.id === id); return d && (typeof d.name === 'object' ? d.name.vi : d.name); };
  const sideByPanel = Object.fromEntries(panels.map(pl => [pl.id, (dcim.power.feeds.find(f => pduName(f.pdu) === pl.name) || {}).side || null]));
  const peer = (x, type) => (x && x.cable && x.link_peers_type === type && x.link_peers && x.link_peers[0] ? x.link_peers[0].id : null);
  const sourcesOf = deviceId => ports
    .filter(p => p.device && p.device.id === deviceId && peer(p, 'dcim.poweroutlet'))
    .map(p => {
      const outlet = outletById[peer(p, 'dcim.poweroutlet')];
      const input = outlet && outlet.power_port ? portById[outlet.power_port.id] : null;
      const feed = feedById[peer(input, 'dcim.powerfeed')];
      return {
        psu: p.name,
        side: feed && feed.power_panel ? sideByPanel[feed.power_panel.id] : null,
        rpdu: outlet ? devName[outlet.device.id] : null,
        outlet: outlet ? outlet.name : null,
        feed: feed ? feed.name : null,
      };
    })
    .sort((a, b) => a.psu.localeCompare(b.psu));
  const uOf = Object.fromEntries(types.map(t => [t.id, Number(t.u_height)]));
  const slugOf = Object.fromEntries(types.map(t => [t.id, t.slug]));
  const typeKey = Object.fromEntries(realKeys(dcim.deviceTypes).map(([k, t]) => [t.model.toLowerCase().replace(/[^a-z0-9]+/g, '-'), k]));
  const maxW = {};
  for (const p of ports) {
    const id = p.device && p.device.id;
    if (id && num(p.maximum_draw) !== null) maxW[id] = Math.max(maxW[id] || 0, p.maximum_draw);
  }
  return {
    source: 'netbox',
    racks: racks
      .filter(r => r.facility_id && r.facility_id.startsWith(nb.keyPrefix))
      .map(r => ({
        id: r.facility_id.slice(nb.keyPrefix.length),
        name: r.name,
        uHeight: Number(r.u_height),
        devices: devs
          .filter(d => d.rack && d.rack.id === r.id && d.position !== null && d.position !== undefined && uOf[d.device_type.id] > 0)
          .map(d => ({
            name: d.name,
            type: typeKey[slugOf[d.device_type.id]] || slugOf[d.device_type.id],
            u: uOf[d.device_type.id],
            position: Number(d.position),
            ratedKw: (maxW[d.id] || 0) / 1000,
            sources: sourcesOf(d.id),
          }))
          .sort((a, b) => a.position - b.position),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
  };
}

// Các khoảng U trống liên tiếp, từ dưới lên: [{ start, size }]
function freeBlocks(rack) {
  const used = new Array(rack.uHeight + 1).fill(false);
  for (const d of rack.devices) for (let i = d.position; i < d.position + d.u && i <= rack.uHeight; i++) used[i] = true;
  const out = [];
  for (let i = 1; i <= rack.uHeight; i++) {
    if (used[i]) continue;
    const start = i;
    while (i <= rack.uHeight && !used[i]) i++;
    out.push({ start, size: i - start });
  }
  return out;
}

const level = (pct, warn, crit) => (pct === null ? 'unknown' : pct > crit ? 'crit' : pct > warn ? 'warn' : 'ok');
const worst = (...ls) => ['crit', 'warn', 'unknown', 'ok'].find(l => ls.includes(l)) || 'ok';

// values: snapshot.values của bộ thu thập (vd. 'pdua.r1_kw', 'pdua.total_kw', 'rack1.temp').
function computeCapacity({ inventory, dcim, rules, values = {}, ts = null }) {
  const ruleValue = id => (rules.find(r => r.id === id) || {}).value;
  const tempWarn = ruleValue('rack_hot_warn');
  const tempCrit = ruleValue('rack_hot_crit');
  const { budgetKw, warnPct, critPct } = dcim.rack;
  const pdus = dcim.power.feeds.map(f => f.pdu);
  const limitKw = dcim.power.pduRatedKw * dcim.power.redundancyMaxPct / 100;

  let totalMeasured = 0; // cộng số gốc rồi mới làm tròn
  const racks = inventory.racks.map(r => {
    const n = r.id.replace(/^\D+/, '');
    const perSide = pdus.map(p => num(values[`${p}.r${n}_kw`]));
    const measuredKw = perSide.every(v => v === null) ? null : perSide.reduce((s, v) => s + (v || 0), 0);
    totalMeasured += measuredKw || 0;
    const ratedKw = r.devices.reduce((s, d) => s + d.ratedKw, 0);
    const usedU = r.devices.reduce((s, d) => s + d.u, 0);
    const blocks = freeBlocks(r);
    const temp = num(values[`${r.id}.temp`]);
    // Phần trăm dùng điện theo số đo; chưa có số đo thì theo công suất định mức
    const powerPct = (measuredKw ?? ratedKw) / budgetKw * 100;
    const power = level(powerPct, warnPct, critPct);
    const thermal = temp === null ? 'unknown' : temp > tempCrit ? 'crit' : temp > tempWarn ? 'warn' : 'ok';
    return {
      id: r.id,
      name: r.name,
      u: { total: r.uHeight, used: usedU, free: r.uHeight - usedU, largestFree: Math.max(0, ...blocks.map(b => b.size)), blocks },
      power: {
        budgetKw,
        ratedKw: round(ratedKw),
        measuredKw: round(measuredKw),
        headroomKw: round(budgetKw - (measuredKw ?? ratedKw)),
        pct: round(powerPct, 0),
        level: power,
      },
      thermal: { inletC: round(temp), warnC: tempWarn, critC: tempCrit, headroomC: temp === null ? null : round(tempWarn - temp), level: thermal },
      level: worst(power, thermal),
      devices: r.devices,
    };
  });

  const floor = dcim.power.feeds.map(f => {
    const total = num(values[`${f.pdu}.total_kw`]);
    const status = num(values[`${f.pdu}.status`]);
    return {
      side: f.side,
      pdu: f.pdu,
      ratedKw: dcim.power.pduRatedKw,
      redundancyLimitKw: limitKw,
      measuredKw: round(total),
      headroomTo2nKw: total === null ? null : round(limitKw - total),
      inputLost: status === 1,
      level: total === null ? 'unknown' : status === 1 ? 'crit' : total > limitKw ? 'warn' : 'ok',
    };
  });

  return {
    ts,
    source: inventory.source,
    thresholds: { budgetKw, warnPct, critPct, tempWarnC: tempWarn, tempCritC: tempCrit, redundancyLimitKw: limitKw },
    racks,
    floor,
    totals: {
      ratedKw: round(racks.reduce((s, r) => s + r.power.ratedKw, 0)),
      measuredKw: round(totalMeasured),
      freeU: racks.reduce((s, r) => s + r.u.free, 0),
    },
  };
}

// "Lắp count thiết bị (u U, ratedKw kW mỗi cái) vào đâu?"
// Một rack phù hợp khi: còn đủ khoảng U liên tiếp, còn đủ kW trong ngân sách, nhiệt độ chưa vượt ngưỡng cảnh báo.
// Ở mức PDU sàn: tải mới chia đều hai phía A/B; nếu một phía vượt ngưỡng 2N thì báo mất dự phòng,
// dù rack vẫn còn chỗ.
function planPlacement(capacity, { u, ratedKw, count = 1 }) {
  if (!(u > 0) || !(ratedKw > 0) || !(count >= 1)) throw new Error('Cần u > 0, ratedKw > 0 và count ≥ 1');
  const needKw = ratedKw * count;
  const candidates = capacity.racks.map(r => {
    const reasons = [];
    const slots = r.u.blocks.reduce((s, b) => s + Math.floor(b.size / u), 0);
    if (slots < count) reasons.push({ code: 'space', need: u * count, largestFree: r.u.largestFree, slots });
    if (r.power.headroomKw < needKw) reasons.push({ code: 'power', needKw: round(needKw), headroomKw: r.power.headroomKw });
    if (r.thermal.level === 'warn' || r.thermal.level === 'crit') reasons.push({ code: 'thermal', inletC: r.thermal.inletC, warnC: r.thermal.warnC });
    const afterKw = r.power.headroomKw - needKw;
    return { rack: r.id, name: r.name, fits: reasons.length === 0, reasons, headroomAfterKw: round(afterKw), slots };
  }).sort((a, b) => (b.fits - a.fits) || (b.headroomAfterKw - a.headroomAfterKw));

  const floor = capacity.floor.map(f => {
    const after = f.measuredKw === null ? null : round(f.measuredKw + needKw / 2);
    return { side: f.side, pdu: f.pdu, measuredKw: f.measuredKw, afterKw: after, limitKw: f.redundancyLimitKw, keeps2n: after === null ? null : after <= f.redundancyLimitKw };
  });
  return {
    request: { u, ratedKw, count },
    best: (candidates.find(c => c.fits) || {}).rack || null,
    candidates,
    floor,
    keeps2n: floor.every(f => f.keeps2n !== false),
  };
}

// Giữ hồ sơ trong bộ nhớ, làm mới định kỳ từ NetBox; lỗi thì dùng bản gần nhất (hoặc config) và ghi lại lỗi.
class DcimInventory {
  constructor({ client = null, dcim, devices, refreshMs = 60000, clock = Date.now, log = () => {} }) {
    this.client = client;
    this.dcim = dcim;
    this.devices = devices;
    this.fallback = inventoryFromConfig(dcim, devices);
    this.current = this.fallback;
    this.refreshMs = refreshMs;
    this.clock = clock;
    this.log = log;
    this.lastRefresh = 0;
    this.error = null;
    this._loading = null;
  }

  // Không khai báo async: các lần gọi trong lúc đang tải phải nhận đúng cùng một Promise.
  refresh() {
    if (!this.client) return Promise.resolve(this.current);
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const inv = await inventoryFromNetbox(this.client, this.dcim, this.devices);
        if (this.error || this.current.source !== 'netbox') this.log(`hồ sơ lấy từ NetBox (${inv.racks.length} rack)`);
        this.current = inv;
        this.error = null;
      } catch (e) {
        if (this.error !== e.message) this.log(`không đọc được NetBox, dùng ${this.current.source === 'netbox' ? 'bản gần nhất' : 'config/dcim.json'}: ${e.message}`);
        this.error = e.message;
      } finally {
        this.lastRefresh = this.clock();
        this._loading = null;
      }
      return this.current;
    })();
    return this._loading;
  }

  // Trả hồ sơ hiện có ngay; nếu đã cũ thì làm mới ở nền.
  get() {
    if (this.client && this.clock() - this.lastRefresh >= this.refreshMs) this.refresh();
    return { ...this.current, error: this.error, sourceName: this.current.source === 'netbox' ? 'NetBox' : 'config/dcim.json' };
  }
}

module.exports = { inventoryFromConfig, inventoryFromNetbox, freeBlocks, computeCapacity, planPlacement, DcimInventory };

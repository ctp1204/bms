'use strict';
// Đồng bộ mô hình DCIM (config/dcim.json + config/devices.json) vào NetBox.
// Giai đoạn 2: phần khung — site, phòng máy, rack, hãng, role, loại thiết bị (kèm cổng nguồn mẫu),
// tủ phân phối PDU-A/B và power feed tới từng rack.
// Nguyên tắc giống bộ đồng bộ CMDB của iTop: tìm theo khóa tự nhiên, thiếu thì tạo, khác thì sửa,
// chạy lại không tạo trùng, KHÔNG BAO GIỜ XÓA. Tìm thấy nhiều hơn một đối tượng cho cùng khóa thì báo xung đột.

const { loc } = require('./locale');

const slugify = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Giá trị NetBox trả về → dạng so sánh được với giá trị gửi đi:
// trường chọn {value,label} → value; khóa ngoại {id,…} → id; danh sách → sắp xếp.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm).sort((a, b) => String(a).localeCompare(String(b)));
  if (v && typeof v === 'object') return 'value' in v ? v.value : 'id' in v ? v.id : v;
  return v;
}
function same(cur, want) {
  const a = norm(cur);
  const b = norm(want);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  if (typeof b === 'number' || typeof a === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

class Syncer {
  constructor(client, log = () => {}) {
    this.client = client;
    this.log = log;
    this.result = { created: [], updated: [], unchanged: [], conflicts: [] };
  }

  // Trả về id của đối tượng (null nếu xung đột).
  async ensure(endpoint, query, fields, label) {
    const found = await this.client.list(endpoint, query);
    if (found.length > 1) {
      this.result.conflicts.push({ endpoint, label, ids: found.map(o => o.id) });
      this.log(`  XUNG ĐỘT ${label}: có ${found.length} đối tượng trùng khóa (${found.map(o => `#${o.id}`).join(', ')}). Bỏ qua.`);
      return null;
    }
    if (found.length === 0) {
      const o = await this.client.create(endpoint, fields);
      this.result.created.push({ endpoint, label, id: o.id });
      this.log(`  tạo      ${label}`);
      return o.id;
    }
    const cur = found[0];
    const diff = {};
    for (const [k, v] of Object.entries(fields)) if (!same(cur[k], v)) diff[k] = v;
    if (Object.keys(diff).length === 0) {
      this.result.unchanged.push({ endpoint, label, id: cur.id });
      return cur.id;
    }
    await this.client.update(endpoint, cur.id, diff);
    this.result.updated.push({ endpoint, label, id: cur.id, fields: Object.keys(diff) });
    this.log(`  cập nhật ${label}: ${Object.keys(diff).join(', ')}`);
    return cur.id;
  }
}

const realKeys = o => Object.entries(o).filter(([k]) => !k.startsWith('$'));
const requireId = (id, what) => {
  if (id === null) throw new Error(`Không đi tiếp được vì ${what} đang xung đột trong NetBox`);
  return id;
};

// Loại thiết bị cần tạo: máy chủ mẫu và thanh nguồn (deviceTypes) + thiết bị hạ tầng (infra kind=device).
function desiredDeviceTypes(dcim) {
  const out = realKeys(dcim.deviceTypes).map(([key, t]) => ({
    key, model: t.model, slug: slugify(t.model), u: t.u, fullDepth: t.u > 0,
    description: `${loc(t.name, 'vi')} / ${loc(t.name, 'ja')} · ${t.ratedKw} kW`,
    ratedW: Math.round(t.ratedKw * 1000), psu: t.psu || 0, outlets: t.outlets || 0,
  }));
  for (const [type, m] of realKeys(dcim.infra)) {
    if (m.kind !== 'device') continue;
    out.push({ key: type, model: m.model, slug: slugify(m.model), u: 0, fullDepth: false,
      description: `Thiết bị hạ tầng (${type}) trong BMS · EPMS Demo`, ratedW: 0, psu: 0, outlets: 0 });
  }
  return out;
}

async function syncSkeleton(client, dcim, devices, log = () => {}) {
  const s = new Syncer(client, log);
  const nb = dcim.netbox;
  const ids = { racks: {}, deviceTypes: {}, roles: {}, panels: {}, feeds: {} };
  const byId = Object.fromEntries(devices.map(d => [d.id, d]));

  ids.tag = requireId(await s.ensure('extras/tags/', { slug: nb.tag },
    { name: nb.tag, slug: nb.tag, color: '0b6a65', description: 'Tạo bởi bộ đồng bộ BMS · EPMS demo' }, `tag ${nb.tag}`), 'tag');
  const tags = [ids.tag];

  ids.site = requireId(await s.ensure('dcim/sites/', { slug: nb.siteSlug },
    { name: nb.site, slug: nb.siteSlug, status: 'active', tags }, `site ${nb.site}`), 'site');
  ids.location = requireId(await s.ensure('dcim/locations/', { site_id: ids.site, slug: nb.locationSlug },
    { name: nb.location, slug: nb.locationSlug, site: ids.site, status: 'active', tags }, `phòng ${nb.location}`), 'phòng máy');

  for (const r of dcim.racks) {
    const sensor = byId[r.rack];
    if (!sensor) throw new Error(`config/dcim.json: rack ${r.rack} không có trong devices.json`);
    const name = `R${sensor.position}`;
    ids.racks[r.rack] = await s.ensure('dcim/racks/', { site_id: ids.site, facility_id: `${nb.keyPrefix}${r.rack}` }, {
      name, site: ids.site, location: ids.location, status: 'active', facility_id: `${nb.keyPrefix}${r.rack}`,
      form_factor: '4-post-cabinet', width: 19, u_height: dcim.rack.uHeight,
      description: `Ngân sách điện ${dcim.rack.budgetKw} kW · 電力予算 ${dcim.rack.budgetKw} kW`, tags,
    }, `rack ${name}`);
  }

  ids.manufacturer = requireId(await s.ensure('dcim/manufacturers/', { slug: slugify(nb.manufacturer) },
    { name: nb.manufacturer, slug: slugify(nb.manufacturer), tags }, `hãng ${nb.manufacturer}`), 'hãng');

  for (const [slug, r] of realKeys(dcim.roles)) {
    ids.roles[slug] = await s.ensure('dcim/device-roles/', { slug }, { name: r.name, slug, color: r.color, tags }, `role ${slug}`);
  }

  for (const t of desiredDeviceTypes(dcim)) {
    const dt = await s.ensure('dcim/device-types/', { manufacturer_id: ids.manufacturer, slug: t.slug }, {
      manufacturer: ids.manufacturer, model: t.model, slug: t.slug, u_height: t.u, is_full_depth: t.fullDepth,
      description: t.description, tags,
    }, `loại thiết bị ${t.model}`);
    ids.deviceTypes[t.key] = dt;
    if (dt === null) continue;
    // Máy chủ: mỗi nguồn (PSU) chịu được toàn bộ máy, bình thường gánh một nửa.
    for (let i = 1; i <= t.psu; i++) {
      await s.ensure('dcim/power-port-templates/', { device_type_id: dt, name: `PSU${i}` },
        { device_type: dt, name: `PSU${i}`, maximum_draw: t.ratedW, allocated_draw: Math.round(t.ratedW / t.psu) }, `  ${t.model} PSU${i}`);
    }
    if (t.outlets) {
      const input = requireId(await s.ensure('dcim/power-port-templates/', { device_type_id: dt, name: 'Input' },
        { device_type: dt, name: 'Input', maximum_draw: t.ratedW }, `  ${t.model} Input`), `${t.model} Input`);
      for (let i = 1; i <= t.outlets; i++) {
        await s.ensure('dcim/power-outlet-templates/', { device_type_id: dt, name: `Outlet ${i}` },
          { device_type: dt, name: `Outlet ${i}`, power_port: input }, `  ${t.model} Outlet ${i}`);
      }
    }
  }

  const f = dcim.power.feed;
  for (const feed of dcim.power.feeds) {
    const pdu = byId[feed.pdu];
    const name = loc(pdu.name, 'vi');
    const panel = await s.ensure('dcim/power-panels/', { site_id: ids.site, name }, {
      site: ids.site, location: ids.location, name, tags,
      description: `Tủ phân phối sàn phía ${feed.side}, ${dcim.power.pduRatedKw} kW, cấp từ ${loc(byId[dcim.power.ups].name, 'vi')}`,
    }, `tủ phân phối ${name}`);
    ids.panels[feed.side] = panel;
    if (panel === null) continue;
    for (const r of dcim.racks) {
      if (ids.racks[r.rack] === null) continue;
      const feedName = `R${byId[r.rack].position}-${feed.side}`;
      ids.feeds[`${r.rack}:${feed.side}`] = await s.ensure('dcim/power-feeds/', { power_panel_id: panel, name: feedName }, {
        power_panel: panel, rack: ids.racks[r.rack], name: feedName, status: 'active',
        type: feed.side === 'A' ? 'primary' : 'redundant', supply: 'ac', phase: f.phase,
        voltage: f.voltage, amperage: f.amperage, max_utilization: f.maxUtilization, tags,
      }, `power feed ${feedName}`);
    }
  }

  return { result: s.result, ids };
}

module.exports = { syncSkeleton, desiredDeviceTypes, Syncer, slugify, same };

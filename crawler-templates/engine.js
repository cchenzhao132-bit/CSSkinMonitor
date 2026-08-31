/* ---------- 以下为运行时引擎（模拟历史波动 + 榜单 + SVG 兜底） ---------- */

// 涨跌业务阈值 —— 全链路唯一配置（v7.0 数据契约）
// 产品定义（与榜单/分类/测试统一引用，禁止在别处硬编码）：
//   rising      涨/跌榜门槛：变动 > ±0.15% 即入涨跌榜（否则归入「无变动榜」）
//   noticeable  明显上涨/下跌：≥ ±3%（changeClass: up1 / down1）
//   strong      大涨/大跌：≥ ±10%（changeClass: up2 / down2）
//   win7d       7 日涨跌锚点容差：±2 天内找到 7 天前的真实锚点才算「7 日」，否则标记数据不足
const CHANGE_THRESHOLDS = {
  rising: 0.15,
  noticeable: 3,
  strong: 10,
  win7d: 2
};
// 供测试与前端统一引用（data.js 先于前端各 js 加载）
window.__CHANGE_THRESHOLDS = CHANGE_THRESHOLDS;
// 供契约审计测试直接验证核心业务不变量（tests/contract-audit.js）
window.__engineCore = { find7dAnchor, changeClassOf, CHANGE_THRESHOLDS };

// 涨跌分类（changePercent 单位：百分点；null = 数据不足）—— 与 CHANGE_THRESHOLDS 单一来源
function changeClassOf(pct) {
  if (pct == null || !isFinite(pct)) return 'none';
  const T = CHANGE_THRESHOLDS;
  if (pct >= T.strong) return 'up2';
  if (pct >= T.noticeable) return 'up1';
  if (pct <= -T.strong) return 'down2';
  if (pct <= -T.noticeable) return 'down1';
  return 'flat';
}

// 7 日涨跌锚点：按时间戳寻找「UTC 今天-7 天 ± win7d 天」内的真实历史点。
// 时区口径与 crawler.js 完全一致：crawler 用 new Date().toISOString().slice(0,10)（UTC 日期）
// 写入快照/锚点日期，这里同样按 UTC 解析（date+'T00:00:00Z'），避免本地时区偏移 8 小时
// 造成「今天」的快照被当成「昨天」（此前用 Date.parse(date+'T00:00:00') 本地解析）。
// 找不到（如仅剩 15/45 天前锚点）→ 返回 null，调用方标记「数据不足」，
// 禁止用最老锚点静默冒充 7 日（v7.0 数据契约；此前 priceHistory[length-8] 会退化成 15/45 日）。
function find7dAnchor(priceHistory) {
  if (!priceHistory || priceHistory.length === 0) return null;
  const T = CHANGE_THRESHOLDS;
  // UTC 今天（与 crawler 的 TODAY 同口径）；目标 = UTC 今天 00:00 − 7 天
  const utcToday = new Date().toISOString().slice(0, 10);
  const target = Date.parse(utcToday + 'T00:00:00Z') - 7 * 86400000;
  let best = null, bestDiff = Infinity;
  for (const p of priceHistory) {
    const t = Date.parse(p.date + 'T00:00:00Z');   // 一律按 UTC 解析（crawler 写入口径）
    if (isNaN(t)) continue;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  if (!best || bestDiff > T.win7d * 86400000) return null;
  return best;
}

// 带种子的伪随机数（每次打开数据一致）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 品质定义
const RARITY = {
  common: { name: '普通级', color: '#b0c3d9' },
  mil:    { name: '军规级', color: '#4b69ff' },
  restr:  { name: '受限级', color: '#8847ff' },
  clsfd:  { name: '保密级', color: '#d32ce6' },
  covert: { name: '隐秘级', color: '#eb4b4b' },
  rare:   { name: '非凡级', color: '#ffd700' },
  contra: { name: '违禁级', color: '#e4ae39' }
};

// 分类定义（cat 键与 crawler.js 保持一致）
const CAT = {
  rifle:   { name: '步枪' },
  sniper:  { name: '狙击枪' },
  pistol:  { name: '手枪' },
  smg:     { name: '冲锋枪' },
  shotgun: { name: '霰弹枪' },
  mg:      { name: '机枪' },
  knife:   { name: '刀具' },
  glove:   { name: '手套' },
  sticker: { name: '印花' },
  graffiti:{ name: '涂鸦' },
  music:   { name: '音乐盒' },
  charm:   { name: '挂件' },
  patch:   { name: '布章' },
  agent:   { name: '探员' },
  capsule: { name: '胶囊' },
  case:    { name: '武器箱' },
  misc:    { name: '其他' }
};

const DAYS = 90;
// 全库共享的 90 天日期数组（只建一次；此前每件饰品每天 new 一个 Date，3 万件 = 280 万次）
// 锚点 = 生成/加载时刻（此前硬编码 2026-08-29，每日重新生成后模拟段日期永久停在当天，
// 真实快照日期继续前进，图表日期轴出现越来越大的错位）
const TODAY_ANCHOR = new Date();
const DATES = Array.from({ length: DAYS }, (_, i) => {
  const d = new Date(TODAY_ANCHOR);
  d.setDate(d.getDate() - (DAYS - 1 - i));
  return d.toISOString().slice(0, 10);
});
// 本地没有的图片按 icon 哈希拼 CDN 地址（data.js 只存哈希，省 ~2MB）
const CDN_IMG = 'https://community.cloudflare.steamstatic.com/economy/image/';
// 价格档位越低波动越剧烈
const volOf = p => p < 50 ? 0.020 : p < 200 ? 0.016 : p < 1000 ? 0.013 : 0.010;

// 每日真实历史（HISTORY 由 crawler 注入：{ byName: { name: [[dateISO, priceCNY], ...] } }）
function realHistoryOf(name) {
  if (typeof HISTORY === 'undefined' || !HISTORY || !HISTORY.byName) return null;
  const row = HISTORY.byName[name];
  if (!row || row.length < 8) return null;
  const pts = [];
  for (const pr of row) {
    if (!pr || pr[1] == null) continue;
    pts.push({ date: pr[0], price: pr[1] });
  }
  return pts.length >= 8 ? pts : null;
}

// 反向随机游走：len 天模拟序列，末点锚定 endpoint
function simWalk(seed, endpoint, len) {
  const rnd = mulberry32(seed * 7919 + 13);
  const vol = volOf(endpoint);
  const drift = (rnd() - 0.5) * 0.0035;
  const series = new Array(len);
  series[len - 1] = endpoint;
  for (let i = len - 2; i >= 0; i--) {
    const noise = (rnd() - 0.5) * 2 * vol;
    series[i] = Math.max(endpoint * 0.3, series[i + 1] / (1 + drift + noise));
  }
  return series;
}

// 生成 90 天价格历史：优先真实快照（≥8 天），前置模拟补齐；不足则整段模拟（终点锚定真实当前价）
function buildItem(def) {
  const r2 = p => Math.round(p * 100) / 100;

  const real = realHistoryOf(def.name);
  const realLen = real ? real.length : 0;
  let priceHistory;
  if (realLen >= 8) {
    const simLen = DAYS - realLen;
    const simSeries = simLen > 0 ? simWalk(def.id, real[0].price, simLen + 1) : [];
    const pts = simSeries.slice(0, simLen).map((price, i) => ({ date: DATES[i], price: r2(price) }));
    priceHistory = pts.concat(real.map(p => ({ date: p.date, price: p.price })));
  } else if (def.hist && def.hist.length >= 2) {
    // 第三方成交窗口锚点（Skinport 24h/7d/30d/90d 中位价，真实成交数据）
    priceHistory = def.hist.map(pr => ({ date: pr[0], price: pr[1] }));
  } else {
    priceHistory = simWalk(def.id, def.base, DAYS).map((price, i) => ({ date: DATES[i], price: r2(price) }));
  }
  const historyReal = realLen >= 8 || (def.hist && def.hist.length >= 2) ? true : false;

  const currentPrice = priceHistory.length ? priceHistory[priceHistory.length - 1].price : null;
  // 7 日前价（v7.0 契约）：
  //   1) 优先用回填的 7 日成交中位（chgPrev，第三方真实成交口径）；
  //   2) 否则按时间戳找「今天-7 天 ± 2 天」内的真实锚点；
  //   3) 都找不到（短历史/仅剩 15/45 天锚点）→ previousPrice=null，涨跌标记「数据不足」，
  //      绝不把 15/45 日前价格冒充 7 日。
  const previousPrice = def.chgPrev != null ? def.chgPrev
    : (priceHistory.length ? (find7dAnchor(priceHistory) || {}).price : null);
  // 涨跌可得性（v7.0 契约）：
  //   - 必须存在正基准价（chgPrev 或 7 日真实锚点）；
  //   - refOnly（第三方参考价占位）且无真实历史（快照/第三方锚点）的条目：
  //     不得用模拟序列算涨跌（旧语义：不进榜单，UI 标注「快照积累中」）。
  const prevValid = previousPrice != null && isFinite(previousPrice) && previousPrice > 0 && currentPrice != null;
  const chgAvail = prevValid && (def.refOnly !== 1 || historyReal);
  const changeAmount = chgAvail ? Math.round((currentPrice - previousPrice) * 100) / 100 : null;
  const changePercent = chgAvail ? Math.round((changeAmount / previousPrice) * 10000) / 100 : null;
  const prices = priceHistory.map(p => p.price);
  const lowestPrice = prices.length ? Math.round(Math.min(...prices) * 100) / 100 : null;
  const highestPrice = prices.length ? Math.round(Math.max(...prices) * 100) / 100 : null;

  // 涨跌分类：大涨/上涨/盘整/下跌/大跌；无 7 日锚点或 refOnly 且历史不足时如实标「无数据」
  const changeClass = changeClassOf(changePercent);

  return {
    id: def.id,
    name: def.name,
    image: def.image || (CDN_IMG + def.icon + '/144fx144'),   // 本地 images/*.png 或按 icon 拼 Steam CDN
    icon: def.icon || null,                 // CDN 兜底用哈希（Akamai 备用源）
    currentPrice, previousPrice, changeAmount, changePercent,
    chgAvail,                             // 7 日涨跌是否可得（previousPrice 有真实 7 日锚点/回填中位）
    lowestPrice, highestPrice, priceHistory,
    listPrice: def.base,                     // 真实挂牌价（爬取时点；refOnly 条目为三方最低参考）——炼金等定价敏感场景用，currentPrice 是图表末点、可能含模拟游走扰动
    historyReal,
    changeClass,
    rarity: def.rarity, rarityName: RARITY[def.rarity].name, rarityColor: RARITY[def.rarity].color,
    cat: def.cat, catName: (CAT[def.cat] || CAT.misc).name,
    hot: def.hot === 1,                     // 热门池标记（最近一次爬取刷新过价格）
    ref: def.ref || null,                   // 第三方市场参考价 { sp: Skinport, mc: market.csgo, wx: Waxpeer }
    p7: def.p7 > 0 ? def.p7 : null,         // 7 日成交中位价（Skinport，成交量≥3）——炼金产出"成交口径"定价
    refOnly: def.refOnly === 1,             // Steam 未采集、仅第三方参考价的条目（不进榜单）
    cn: def.cn || def.name,                 // 中文显示名
    sil: def.sil
  };
}

const ALL_ITEMS = RAW.map(buildItem);
// 涨跌榜 = 全部有涨跌数据的条目（Steam 采集条目；第三方条目快照满 8 天自动加入）
// hot 标记仅表示"最近一次爬取刷新过价格"，不再限制榜单范围
const byRise = (a, b) => b.changePercent - a.changePercent;
const byFall = (a, b) => a.changePercent - b.changePercent;
// 榜单门槛统一引用 CHANGE_THRESHOLDS.rising（v7.0 契约；禁止魔法数 0.15 散落）
const RISING = ALL_ITEMS.filter(i => i.changeClass !== 'none' && i.changePercent > CHANGE_THRESHOLDS.rising).sort(byRise);
const FALLING = ALL_ITEMS.filter(i => i.changeClass !== 'none' && i.changePercent <= -CHANGE_THRESHOLDS.rising).sort(byFall);
// 无变动榜 = 涨跌榜的精确补集（盘整 ±rising% 内 + 涨跌积累中条目），按当前价排序——全库饰品的价格目录
const _riseSet = new Set(RISING), _fallSet = new Set(FALLING);
const FLAT = ALL_ITEMS.filter(i => !_riseSet.has(i) && !_fallSet.has(i))
  .sort((a, b) => b.currentPrice - a.currentPrice);
const HOT_COUNT = ALL_ITEMS.filter(i => i.hot).length;

// ---------- SVG 剪影兜底图 ----------
function weaponSilhouette(type) {
  const S = {
    rifle: `<polygon points="6,28 30,24 30,38 14,40"/><rect x="30" y="26" width="56" height="8" rx="1.5"/><rect x="86" y="28" width="26" height="4" rx="1.5"/><rect x="50" y="19" width="16" height="7" rx="1.5"/><polygon points="46,34 44,50 54,52 57,35"/><polygon points="64,34 64,47 71,47 69,34"/>`,
    sniper: `<polygon points="4,26 26,24 26,40 10,42"/><rect x="26" y="26" width="58" height="10" rx="1.5"/><rect x="84" y="28" width="30" height="5" rx="2"/><rect x="38" y="12" width="26" height="8" rx="3"/><rect x="44" y="20" width="3" height="7"/><rect x="54" y="20" width="3" height="7"/><polygon points="56,36 54,48 60,48 59,36"/>`,
    pistol: `<rect x="28" y="18" width="52" height="11" rx="2"/><rect x="32" y="29" width="34" height="6" rx="1.5"/><polygon points="32,29 32,52 50,52 44,30"/><path d="M60 29 q10 8 8 16 l-6 -2 q2 -6 -4 -10 z"/>`,
    knife: `<path d="M18 32 Q50 6 96 14 Q60 18 46 30 L44 36 L18 38 Z"/><rect x="12" y="32" width="36" height="7" rx="3"/><rect x="46" y="27" width="4" height="17" rx="2"/>`,
    claw: `<path d="M14 44 Q30 10 88 8 Q58 18 52 28 Q70 14 100 22 Q64 30 50 38 Q40 46 24 50 Z"/><rect x="8" y="40" width="34" height="7" rx="3" transform="rotate(-14 25 43)"/>`,
    glove: `<path d="M28 52 Q20 30 30 22 Q38 16 44 24 L46 14 Q47 8 52 10 Q56 12 55 20 L57 16 Q58 10 63 12 Q67 14 65 22 L68 20 Q72 18 74 24 Q76 30 68 36 Q58 46 44 52 Z"/><rect x="26" y="48" width="46" height="9" rx="4.5"/>`,
    misc: `<rect x="30" y="20" width="68" height="56" rx="9" fill-opacity="0.55"/><circle cx="64" cy="48" r="17" fill-opacity="0.9"/><rect x="38" y="28" width="52" height="6" rx="3" fill-opacity="0.4"/>`
  };
  return S[type] || S.rifle;
}

function itemImageSVG(item, size) {
  const w = size || 128, h = size || 128;
  const c = item.rarityColor;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 96" width="${w}" height="${h}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${c}" stop-opacity="0.28"/>
          <stop offset="1" stop-color="#0d1420" stop-opacity="0.95"/>
        </linearGradient>
      </defs>
      <rect width="128" height="96" rx="10" fill="#131b26"/>
      <rect width="128" height="96" rx="10" fill="url(#bg)"/>
      <rect x="8" y="8" width="112" height="80" rx="6" fill="none" stroke="${c}" stroke-opacity="0.35" stroke-width="1.5"/>
      <g fill="${c}" fill-opacity="0.92" transform="translate(2,4)">${weaponSilhouette(item.sil)}</g>
      <rect x="8" y="86" width="${Math.min(112, 20 + (item.currentPrice / item.highestPrice) * 92)}" height="3" rx="1.5" fill="${c}" fill-opacity="0.8"/>
    </svg>`)}`
}

ALL_ITEMS.forEach(it => { it.fallback = itemImageSVG(it, 128); });

// 供 <img onerror> 使用：两级兜底——先试 Akamai 备用源（主 CDN 失败常为网络抖动），再退 SVG 剪影
window.__imgFallback = function (img, id) {
  const item = ALL_ITEMS.find(i => i.id === id);
  if (!item) { img.onerror = null; return; }
  if (img.dataset.altTry !== '1' && item.icon) {
    img.dataset.altTry = '1';
    img.onerror = () => { img.onerror = null; img.src = item.fallback; };
    img.src = 'https://community.akamai.steamstatic.com/economy/image/' + item.icon + '/144fx144';
    return;
  }
  img.onerror = null;
  img.src = item.fallback;
};

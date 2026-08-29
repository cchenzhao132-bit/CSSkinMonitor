/* ---------- 以下为运行时引擎（模拟历史波动 + 榜单 + SVG 兜底） ---------- */

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
  const today = new Date(2026, 7, 29);
  const dayDate = i => {
    const d = new Date(today);
    d.setDate(d.getDate() - (DAYS - 1 - i));
    return d.toISOString().slice(0, 10);
  };
  const r2 = p => Math.round(p * 100) / 100;

  const real = realHistoryOf(def.name);
  const realLen = real ? real.length : 0;
  let priceHistory;
  if (realLen >= 8) {
    const simLen = DAYS - realLen;
    const simSeries = simLen > 0 ? simWalk(def.id, real[0].price, simLen + 1) : [];
    const pts = simSeries.slice(0, simLen).map((price, i) => ({ date: dayDate(i), price: r2(price) }));
    priceHistory = pts.concat(real.map(p => ({ date: p.date, price: p.price })));
  } else {
    priceHistory = simWalk(def.id, def.base, DAYS).map((price, i) => ({ date: dayDate(i), price: r2(price) }));
  }

  const currentPrice = priceHistory[priceHistory.length - 1].price;
  const previousPrice = priceHistory[priceHistory.length - 8].price;   // 7 日前
  const changeAmount = Math.round((currentPrice - previousPrice) * 100) / 100;
  const changePercent = Math.round((changeAmount / previousPrice) * 10000) / 100;
  const prices = priceHistory.map(p => p.price);
  const lowestPrice = Math.round(Math.min(...prices) * 100) / 100;
  const highestPrice = Math.round(Math.max(...prices) * 100) / 100;

  return {
    id: def.id,
    name: def.name,
    image: def.image,                       // 本地 images/*.png 或 Steam CDN
    currentPrice, previousPrice, changeAmount, changePercent,
    lowestPrice, highestPrice, priceHistory,
    rarity: def.rarity, rarityName: RARITY[def.rarity].name, rarityColor: RARITY[def.rarity].color,
    cat: def.cat, catName: (CAT[def.cat] || CAT.misc).name,
    hot: def.hot === 1,                     // 热门池标记（最近一次爬取刷新过价格）
    sil: def.sil
  };
}

const ALL_ITEMS = RAW.map(buildItem);
// 榜单 = 热门池（涨价区/降价区各取涨幅居前者）；热门池不足时回退全量，保证榜单可用
const byRise = (a, b) => b.changePercent - a.changePercent;
const byFall = (a, b) => a.changePercent - b.changePercent;
const hotRise = ALL_ITEMS.filter(i => i.hot && i.changePercent > 0.15).sort(byRise);
const hotFall = ALL_ITEMS.filter(i => i.hot && i.changePercent <= -0.15).sort(byFall);
const RISING = (hotRise.length >= 10 ? hotRise : ALL_ITEMS.filter(i => i.changePercent > 0.15)).sort(byRise);
const FALLING = (hotFall.length >= 10 ? hotFall : ALL_ITEMS.filter(i => i.changePercent <= -0.15)).sort(byFall);
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

// 供 <img onerror> 使用：切换到 SVG 兜底图
window.__imgFallback = function (img, id) {
  img.onerror = null;
  const item = ALL_ITEMS.find(i => i.id === id);
  if (item) img.src = item.fallback;
};

/**
 * CS 饰品市场爬虫 - 从 Steam 社区市场抓取真实数据
 *
 * 用法：
 *   node crawler.js                       # 热门层（默认）：Steam 热门前 200 条，约 2 分钟，每日刷新用
 *   node crawler.js --mode weapons        # 深度层：武器皮肤全量（含普通/StatTrak/纪念，较久）
 *   node crawler.js --mode knives         # 深度层：刀具/手套全量
 *   node crawler.js --mode collect        # 深度层：收藏品（印花/涂鸦/音乐盒/挂件/布章/探员/胶囊/武器箱）
 *   node crawler.js --mode pages --pages 60   # 翻页模式（热门榜逐页）
 *   node crawler.js --regen               # 离线重建：不访问网络，仅用缓存重新生成 data.js（不刷新价格！）
 *   node crawler.js --offline-img 500     # 价格 Top N 图片本地化（其余运行时走 Steam CDN）
 *   node crawler.js --reset               # 清空缓存重新抓
 *
 * 分层设计：
 *   热门层（默认，每次运行 ~2 分钟）→ 涨价榜/降价榜数据源，价格每日刷新
 *   深度层（weapons/knives/collect，低频运行）→ 全库搜索数据源，价格截至最近一次深度爬取
 *   cache 里 seen=最近刷新日期 的条目进入热门池参与榜单；其余条目仅出现在搜索结果
 *
 * 特性：
 *   - spawn curl 发请求（Steam 屏蔽 Node TLS 指纹，curl 正常；图片下载同样走 curl）
 *   - 断点续传：已抓数据存 cache/crawler-cache.json；已存在的条目只刷新价格
 *   - Steam 未登录时 category 过滤参数全被忽略 → 收藏品用关键词搜索 + type 字段归类
 *   - 价格 Top N 图片下载到本地，其余运行时走 Steam CDN（onerror 回退 SVG 剪影）
 *   - 每次爬取写每日价格快照 cache/price-history.json，data.js 注入 HISTORY（真实历史逐步积累）
 *   - 生成 app/data.js（真实名称/价格/分类 + 磨损价位库 WEARDB[base] = {w, st, sv} + 引擎模板）
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sources = require('./sources');

const ROOT = process.env.CS_SKIN_HOME || __dirname;   // 数据根目录（桌面应用通过环境变量指定 %LOCALAPPDATA% 数据目录）
const APP = path.join(ROOT, 'app');
const CACHE_DIR = path.join(ROOT, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'crawler-cache.json');
const HIST_FILE = path.join(CACHE_DIR, 'price-history.json');
const CATALOG_FILE = path.join(CACHE_DIR, 'catalog.json');
const TRADEUP_FILE = path.join(CACHE_DIR, 'tradeup.json');
const DATA_JS = path.join(APP, 'data.js');
const IMG_DIR = path.join(APP, 'images');

// 武器关键词（覆盖 CS2 全武器）
const WEAPON_QUERIES = [
  'AK-47', 'M4A4', 'M4A1-S', 'AWP', 'USP-S', 'Desert Eagle', 'Glock-18',
  'P250', 'P2000', 'Five-SeveN', 'Tec-9', 'CZ75-Auto', 'R8 Revolver', 'Dual Berettas',
  'MP9', 'MAC-10', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon',
  'Galil AR', 'FAMAS', 'SG 553', 'AUG', 'SSG 08', 'SCAR-20', 'G3SG1',
  'Nova', 'XM1014', 'MAG-7', 'Sawed-Off', 'M249', 'Negev'
];

// 刀具 / 手套专属关键词
const KNIFE_GLOVE_QUERIES = [
  '★ Karambit', '★ Butterfly Knife', '★ M9 Bayonet', '★ Bayonet',
  '★ Talon Knife', '★ Skeleton Knife', '★ Stiletto Knife', '★ Ursus Knife',
  '★ Classic Knife', '★ Nomad Knife', '★ Paracord Knife', '★ Survival Knife',
  '★ Flip Knife', '★ Huntsman Knife', '★ Navaja Knife', '★ Gut Knife',
  '★ Kukri Knife', '★ Bowie Knife', '★ Falchion Knife', '★ Shadow Daggers',
  '★ Sport Gloves', '★ Driver Gloves', '★ Hand Wraps', '★ Moto Gloves',
  '★ Specialist Gloves', '★ Hydra Gloves', '★ Broken Fang Gloves', '★ Bloodhound Gloves'
];

// 收藏品关键词（Steam 未登录不支持分类过滤，用搜索词 + type 归类；[词, 上限]）
const COLLECT_QUERIES = [
  ['Sticker', 2500], ['Capsule', 800], ['Case', 600], ['Charm', 400],
  ['Music Kit', 400], ['Patch', 300], ['Agent', 150], ['Graffiti', 300]
];

// ---------- 参数 ----------
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && !isNaN(+args[i + 1])) return +args[i + 1];
  return dflt;
};
const MODE = (() => {
  if (args.includes('--mode')) {
    const v = args[args.indexOf('--mode') + 1];
    if (v === 'pages') return 'pages';
    if (v === 'knives') return 'knives';
    if (v === 'collect') return 'collect';
    if (v === 'weapons') return 'weapons';
  }
  return 'hot';   // 默认热门层：Steam 热门前 PAGES 页，快速刷新榜单数据源
})();
const REGEN = args.includes('--regen');   // 离线重建：不访问网络，仅用缓存重新生成 data.js（不刷新价格）
const PAGES = getArg('pages', MODE === 'hot' ? 20 : 60);   // 热门层默认 20 页 ≈ 前 200 条
const PAGE_SIZE = 100;
const IMG_TOP = getArg('offline-img', 300);   // 价格 Top N 图片本地化
const RATE_EXCHANGE = getArg('rate', 7.25);   // USD -> CNY 汇率（--rate 可调）
const LIST_DELAY = 3500;                      // listing API 限流间隔 ms
const HIST_MAX_DAYS = 60;                     // 每日快照保留天数（控制 data.js 体积）

// ---------- 工具 ----------
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function curlJSON(url) {
  const out = execFileSync('curl', [
    '-sL', '--max-time', '30',
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126',
    url
  ], { timeout: 40000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(out);
}

// 图片下载也走 curl（Steam CDN 同样拒绝 Node TLS 指纹）
function curlDownload(url, file) {
  try {
    execFileSync('curl', ['-sL', '--max-time', '40', '-o', file, url], { timeout: 50000 });
    return fs.existsSync(file) && fs.statSync(file).size > 3000;
  } catch (e) { return false; }
}

// ---------- 品质 / 分类 / 剪影映射 ----------
const QUALITY = {
  'Consumer':    { zh: '普通级', color: '#b0c3d9', key: 'common' },
  'Mil-Spec':    { zh: '军规级', color: '#4b69ff', key: 'mil' },
  'Restricted':  { zh: '受限级', color: '#8847ff', key: 'restr' },
  'Classified':  { zh: '保密级', color: '#d32ce6', key: 'clsfd' },
  'Covert':      { zh: '隐秘级', color: '#eb4b4b', key: 'covert' },
  'Extraordinary': { zh: '非凡级', color: '#ffd700', key: 'rare' }
};
// 收藏品/探员的品质词 → 品质键（复用现有色阶；违禁级为印花独有）
const QUALITY_EXTRA = {
  'Base Grade': 'common', 'High Grade': 'mil', 'Remarkable': 'restr',
  'Exotic': 'clsfd', 'Contraband': 'contra',
  'Distinguished': 'mil', 'Exceptional': 'restr', 'Superior': 'clsfd', 'Master': 'covert'
};
const QUALITY_KEYS = {
  common: QUALITY['Consumer'], mil: QUALITY['Mil-Spec'], restr: QUALITY['Restricted'],
  clsfd: QUALITY['Classified'], covert: QUALITY['Covert'], rare: QUALITY['Extraordinary'],
  contra: { zh: '违禁级', color: '#e4ae39', key: 'contra' }
};
const QUALITY_FALLBACK = QUALITY_KEYS.common;

// 从 type（如 "Restricted Rifle" / "★ Covert Knife" / "High Grade Sticker"）提取品质
function qualityOf(type) {
  const star = type && type.startsWith('★');
  if (star) return QUALITY['Extraordinary'];   // ★ 刀/手套 = 非凡级
  if (!type) return QUALITY_FALLBACK;
  const main = type.match(/(Consumer|Mil-Spec|Restricted|Classified|Covert|Extraordinary)/);
  if (main) return QUALITY[main[1]];
  for (const word in QUALITY_EXTRA) {
    if (type.includes(word)) return QUALITY_KEYS[QUALITY_EXTRA[word]];
  }
  return QUALITY_FALLBACK;
}

// ---------- 武器分类 ----------
const CATS = {
  rifle:   { zh: '步枪' },
  sniper:  { zh: '狙击枪' },
  pistol:  { zh: '手枪' },
  smg:     { zh: '冲锋枪' },
  shotgun: { zh: '霰弹枪' },
  mg:      { zh: '机枪' },
  knife:   { zh: '刀具' },
  glove:   { zh: '手套' },
  sticker: { zh: '印花' },
  graffiti:{ zh: '涂鸦' },
  music:   { zh: '音乐盒' },
  charm:   { zh: '挂件' },
  patch:   { zh: '布章' },
  agent:   { zh: '探员' },
  capsule: { zh: '胶囊' },
  case:    { zh: '武器箱' },
  misc:    { zh: '其他' }
};
// 从 type + 名称提取分类
function catOf(type, name) {
  if (!type) return 'misc';
  if (/Gloves$/.test(type)) return 'glove';
  if (/Knife$/.test(type)) return 'knife';
  if (/Sniper Rifle$/.test(type)) return 'sniper';
  if (/Shotgun$/.test(type)) return 'shotgun';
  if (/Machinegun$/.test(type)) return 'mg';
  if (/SMG$/.test(type)) return 'smg';
  if (/Pistol$/.test(type)) return 'pistol';
  if (/Rifle$/.test(type)) return 'rifle';
  if (/Music Kit$/.test(type)) return 'music';
  if (/Sticker$/.test(type)) return 'sticker';
  if (/Patch$/.test(type)) return 'patch';
  if (/Charm$/.test(type)) return 'charm';
  if (/Agent$/.test(type)) return 'agent';
  if (/Graffiti$/.test(type)) return 'graffiti';
  if (/Container$/.test(type)) return /Capsule/i.test(name || '') ? 'capsule' : 'case';
  return 'misc';
}

// 收录哪些物品（不再排除纪念版皮肤；排除杂项工具/包裹）
const ITEM_TYPE_RE = /(Rifle|Pistol|SMG|Sniper Rifle|Shotgun|Machinegun|Knife|Gloves|Sticker|Music Kit|Patch|Charm|Agent|Container|Graffiti)/;
const NAME_EXCLUDE = /^(Name Tag|StatTrak Swap|Souvenir Package|Music Kit Box|Genuine|Promo .*(DVD|CD))/i;
function isItem(r) {
  const t = r.asset_description && r.asset_description.type || '';
  if (!ITEM_TYPE_RE.test(t)) return false;
  if (NAME_EXCLUDE.test(r.hash_name)) return false;
  return true;
}
// 剪影类型推断（SVG 兜底用）
const SIL_RULES = [
  [/^★.*(Gloves|Glove)/i, 'glove'],
  [/^★.*(Karambit|Claw|Talon)/i, 'claw'],
  [/^★.*Knife|^★(Bayonet|M9 Bayonet|Bowie|Butterfly|Flip|Gut|Huntsman|Shadow Daggers|Kukri|Paracord|Skeleton|Survival|Classic)/i, 'knife'],
  [/^(AWP|SSG 08|SCAR-20|G3SG1)\b/i, 'sniper'],
  [/^(Desert Eagle|USP-S|Glock|P250|P2000|Five-SeveN|Tec-9|CZ75|R8 Revolver|Dual Berettas)\b/i, 'pistol'],
  [/Sticker$|^Sticker |Sealed Graffiti/i, 'sticker'],
  [/Agent$| Container$|Music Kit$|Patch$|Charm$/i, 'misc'],
];
const silOf = (name, cat) => {
  for (const [re, sil] of SIL_RULES) if (re.test(name)) return sil;
  if (cat === 'sticker' || cat === 'graffiti' || cat === 'capsule' || cat === 'case' || cat === 'music' || cat === 'patch' || cat === 'charm' || cat === 'agent') return 'misc';
  return 'rifle';
};

// 武器前缀 → 分类（目录并集中无 type 字段的条目按名称推断）
const WEAPON_CAT = {
  'AK-47': 'rifle', 'M4A4': 'rifle', 'M4A1-S': 'rifle', 'AWP': 'sniper', 'USP-S': 'pistol',
  'Desert Eagle': 'pistol', 'Glock-18': 'pistol', 'P250': 'pistol', 'P2000': 'pistol',
  'Five-SeveN': 'pistol', 'Tec-9': 'pistol', 'CZ75-Auto': 'pistol', 'R8 Revolver': 'pistol',
  'Dual Berettas': 'pistol', 'MP9': 'smg', 'MAC-10': 'smg', 'MP7': 'smg', 'MP5-SD': 'smg',
  'UMP-45': 'smg', 'P90': 'smg', 'PP-Bizon': 'smg', 'Galil AR': 'rifle', 'FAMAS': 'rifle',
  'SG 553': 'rifle', 'AUG': 'rifle', 'SSG 08': 'sniper', 'SCAR-20': 'sniper', 'G3SG1': 'sniper',
  'Nova': 'shotgun', 'XM1014': 'shotgun', 'MAG-7': 'shotgun', 'Sawed-Off': 'shotgun',
  'M249': 'mg', 'Negev': 'mg',
  '★ Bayonet': 'knife', '★ M9 Bayonet': 'knife', '★ Karambit': 'knife', '★ Butterfly Knife': 'knife',
  '★ Talon Knife': 'knife', '★ Skeleton Knife': 'knife', '★ Stiletto Knife': 'knife',
  '★ Ursus Knife': 'knife', '★ Classic Knife': 'knife', '★ Nomad Knife': 'knife',
  '★ Paracord Knife': 'knife', '★ Survival Knife': 'knife', '★ Flip Knife': 'knife',
  '★ Huntsman Knife': 'knife', '★ Navaja Knife': 'knife', '★ Gut Knife': 'knife',
  '★ Kukri Knife': 'knife', '★ Bowie Knife': 'knife', '★ Falchion Knife': 'knife',
  '★ Shadow Daggers': 'knife'
};
// 无 type 信息时按名称推断分类
function catFromName(name) {
  if (/^Sticker \|/.test(name)) return 'sticker';
  if (/^Sealed Graffiti |^Graffiti/.test(name)) return 'graffiti';
  if (/Music Kit \||Music Kit$/.test(name)) return 'music';
  if (/^Patch \|/.test(name)) return 'patch';
  if (/Charm \|/.test(name)) return 'charm';
  if (/ \| .*(Agent)$/.test(name) || /^Agent /.test(name)) return 'agent';
  if (/Capsule/i.test(name)) return 'capsule';
  if (/ Case | Case$|Package|Souvenir Package/.test(name)) return 'case';
  for (const w in WEAPON_CAT) {
    const prefix = name.replace(/^★ StatTrak™ |^StatTrak™ |^Souvenir /, '');
    if (prefix === w || prefix.startsWith(w + ' |')) return WEAPON_CAT[w];
  }
  if (/^★ |Gloves/.test(name)) return /Gloves|Glove/.test(name) ? 'glove' : 'knife';
  return 'misc';
}

// ---------- 磨损 / 版本解析 ----------
const WEAR_RE = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
const WEAR_KEY = { 'Factory New': 'fn', 'Minimal Wear': 'mw', 'Field-Tested': 'ft', 'Well-Worn': 'ww', 'Battle-Scarred': 'bs' };
// 版本前缀 → { base, col }（w=普通 st=StatTrak sv=纪念）
function parseVariant(name) {
  if (/^Souvenir /.test(name)) return { base: name.slice(9), col: 'sv' };
  if (/^★ StatTrak™ /.test(name)) return { base: '★ ' + name.slice(12), col: 'st' };
  if (/^StatTrak™ /.test(name)) return { base: name.slice(10), col: 'st' };
  return { base: name, col: 'w' };
}
// WEARDB[base] = { cat, w:{fn..van}, st:{}, sv:{} } —— 同皮肤三版本 × 磨损的真实挂牌价
function buildWearDB(cache) {
  const fam = {};
  for (const e of Object.values(cache)) {
    const v = parseVariant(e.name);
    const m = v.base.match(WEAR_RE);
    const base = m ? v.base.slice(0, m.index) : v.base;   // 无磨损后缀（原版刀具/收藏品）自成家族
    const wk = m ? WEAR_KEY[m[1]] : 'van';
    fam[base] = fam[base] || { cat: e.cat || catOf(e.type, e.name), w: {}, st: {}, sv: {} };
    fam[base][v.col][wk] = Math.round(e.usd * RATE_EXCHANGE * 100) / 100;
  }
  return fam;
}

// ---------- 主流程 ----------
(async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });

  // 断点续传（--reset 清空重来）
  let cache = {};
  if (fs.existsSync(CACHE_FILE) && !args.includes('--reset')) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log('cache 已有', Object.keys(cache).length, '条，断点续传（已存在条目将刷新价格）');
  }

  // 已收录条目：只更新价格，不重复下载信息；本次刷新/新增的条目标记 seen（热门池依据）
  const TODAY = new Date().toISOString().slice(0, 10);
  const toCNY = usd => Math.round(usd * RATE_EXCHANGE * 100) / 100;
  let total = 0, sinceSave = 0, refreshed = 0;
  const addResults = j => {
    total = total || j.total_count;
    let added = 0;
    for (const r of (j.results || [])) {
      if (!r.hash_name || !r.asset_description) continue;
      if (!isItem(r)) continue;
      const price = r.sell_price; // 美分
      if (!price || price < 3) continue;  // 跳过无价/超低价
      const icon = r.asset_description.icon_url;
      const type = r.asset_description.type;
      if (cache[r.hash_name]) {
        const prev = cache[r.hash_name].usd;
        cache[r.hash_name].usd = price / 100;
        if (icon) cache[r.hash_name].icon = icon;
        if (!cache[r.hash_name].cat) cache[r.hash_name].cat = catOf(type, r.hash_name);   // 老缓存补分类
        cache[r.hash_name].seen = TODAY;
        if (prev !== cache[r.hash_name].usd) refreshed++;
        continue;
      }
      const q = qualityOf(type);
      if (!icon) continue;
      cache[r.hash_name] = {
        name: r.hash_name,
        usd: price / 100,
        icon,
        quality: q.key,
        type,
        cat: catOf(type, r.hash_name),
        seen: TODAY
      };
      added++;
    }
    return added;
  };

  const fetchWithRetry = async url => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return curlJSON(url); } catch (e) {
        console.log(`  attempt ${attempt} 失败: ${e.message}`);
        await sleep(8000);
      }
    }
    return null;
  };

  // 自适应翻页：Steam 无视 count 固定返回 ~10 条/页，按实际返回数推进
  const crawlQuery = async (wq, maxItems) => {
    let start = 0, got = 0, qTotal = Infinity, idle = 0;
    while (start < qTotal && got < maxItems && idle < 2) {
      const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=100&start=${start}&query=${encodeURIComponent(wq)}`;
      const j = await fetchWithRetry(url);
      if (!j || !j.results || !j.results.length) { idle++; continue; }
      qTotal = Math.min(qTotal, j.total_count);
      addResults(j);
      got += j.results.length;
      start += j.results.length;
      if (++sinceSave >= 10) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); sinceSave = 0; }
      process.stdout.write(`  "${wq}" ${start}/${qTotal}（累计 ${Object.keys(cache).length}，刷新价 ${refreshed}）\r`);
      await sleep(LIST_DELAY);
    }
    console.log(`  "${wq}" 完成: ${got} 条（上限 ${maxItems}）`);
  };

  if (!REGEN) {
    if (MODE === 'weapons') {
      console.log(`模式：武器全量（${WEAPON_QUERIES.length} 个武器，自适应翻页，每类上限 1200）`);
      for (let w = 0; w < WEAPON_QUERIES.length; w++) {
        await crawlQuery(WEAPON_QUERIES[w], 1200);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      }
    }
    if (MODE === 'knives') {
      console.log(`模式：刀具/手套全量（${KNIFE_GLOVE_QUERIES.length} 类，每类上限 3000）`);
      for (let w = 0; w < KNIFE_GLOVE_QUERIES.length; w++) {
        await crawlQuery(KNIFE_GLOVE_QUERIES[w], 3000);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      }
    }
    if (MODE === 'collect') {
      console.log(`模式：收藏品（${COLLECT_QUERIES.length} 类关键词，含上限）`);
      for (const [q, cap] of COLLECT_QUERIES) {
        await crawlQuery(q, cap);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      }
    }
    if (MODE === 'pages' || MODE === 'hot') {
      console.log(`模式：${MODE === 'hot' ? '热门层' : '翻页'}（${PAGES} 页，Steam 热门排序）`);
      for (let p = 0; p < PAGES; p++) {
        const start = p * PAGE_SIZE;
        const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=${PAGE_SIZE}&start=${start}&query=`;
        const j = await fetchWithRetry(url);
        const added = j ? addResults(j) : 0;
        console.log(`page ${p + 1}/${PAGES} start=${start}: +${added}（累计 ${Object.keys(cache).length}）`);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
        if (p < PAGES - 1) await sleep(LIST_DELAY);
      }
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

    // ---- 第三方市场目录 + 参考价（每轮各 1 次请求，单源失败不影响主流程） ----
    try {
      const src = await sources.fetchAll(console.log);
      const names = new Set();
      Object.values(src).forEach(m => Object.keys(m).forEach(n => names.add(n)));
      const items = {};
      for (const n of names) {
        const e = {};
        if (src.skinport && src.skinport[n]) e.skinport = src.skinport[n];
        if (src.mcsgo && src.mcsgo[n]) e.mcsgo = src.mcsgo[n];
        if (src.waxpeer && src.waxpeer[n]) e.waxpeer = src.waxpeer[n];
        if (Object.keys(e).length) items[n] = e;
      }
      fs.writeFileSync(CATALOG_FILE, JSON.stringify({ syncedAt: TODAY, items }));
      const steamNames = new Set(Object.keys(cache));
      const union = Object.keys(items);
      const covered = union.filter(n => steamNames.has(n)).length;
      console.log(`第三方目录并集：${union.length} 条；Steam 缓存已覆盖 ${covered}（${(covered / union.length * 100).toFixed(1)}%），缺口由深度层逐步补全`);
    } catch (e) {
      console.log('第三方目录同步失败（跳过）:', e.message);
    }

    // ---- 可选：Skinport 成交历史回填（--backfill N）----
    // 用真实成交窗口中位价（24h/7d/30d/90d）为第三方条目构造历史锚点，立刻获得真实涨跌分类
    // 限流：Skinport 全端点 8 次/5 分钟 → 每批 10 个名称、批间 40s；按参考价从高到低优先
    const BF_N = getArg('backfill', 0);
    if (BF_N > 0 && fs.existsSync(CATALOG_FILE)) {
      try {
        const catData = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
        const targets = [];
        for (const [name, c] of Object.entries(catData.items)) {
          if (cache[name] || c.histAt) continue;                 // Steam 条目走 --history；已回填跳过
          if (!(c.skinport && c.skinport.min > 0)) continue;
          targets.push([name, c.skinport.min, c.skinport.qty || 0]);
        }
        // 成交活跃度优先：流动性好的物品才有意义的「7 日涨跌」（否则 7 天成交不足 3 次会被门槛跳过）
        targets.sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]));
        const list = targets.slice(0, BF_N).map(t => t[0]);
        console.log(`历史回填：${list.length}/${targets.length} 条待回填（限流 75s/批 × 100 名称）`);
        const BATCH = 100, BF_DELAY = 75000;   // 每请求 100 个名称；75s 间隔 = 4 次/5 分钟，给 8 次/5 分钟文档限流留足余量（贴线飞行会触发 429 惩罚）
        let done = 0;
        for (let i = 0; i < list.length; i += BATCH) {
          const batch = list.slice(i, i + BATCH);
          let res = null, attempt = 0;
          while (attempt < 3) {
            try { res = await sources.skinportHistory(batch); break; }
            catch (e) {
              attempt++;
              const is429 = /429/.test(e.message);
              const wait = is429 ? 600000 * attempt : 20000;   // 429：退避 10/20 分钟，等限流窗口过去；其他错误 20s
              console.log(`  batch ${i / BATCH + 1} attempt ${attempt} 失败（${e.message}），等待 ${Math.round(wait / 1000)}s 后重试`);
              await sleep(wait);
            }
          }
          if (Array.isArray(res)) {
            for (const it of res) {
              const c = catData.items[it.market_hash_name];
              if (!c || !it.last_7_days || !(it.last_7_days.median > 0) || !(it.last_7_days.volume >= 3)) continue;   // 流动性不足 → 保持无数据
              const m = it.last_24_hours && it.last_24_hours.median > 0 ? it.last_24_hours.median : it.last_7_days.median;
              const m7 = it.last_7_days.median, m30 = it.last_30_days && it.last_30_days.median > 0 ? it.last_30_days.median : m7, m90 = it.last_90_days && it.last_90_days.median > 0 ? it.last_90_days.median : m30;
              const d = n => { const dt = new Date(Date.now() - n * 86400000); return dt.toISOString().slice(0, 10); };
              const anchors = {};
              anchors[d(0)] = m, anchors[d(3)] = m7, anchors[d(15)] = m30, anchors[d(45)] = m90;
              c.hist = {
                a: Object.entries(anchors).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([dd, p]) => [dd, toCNY(p)]),
                p7: toCNY(m7)
              };
              c.histAt = TODAY;
              done++;
            }
          }
          fs.writeFileSync(CATALOG_FILE, JSON.stringify(catData));
          process.stdout.write(`  回填进度 ${Math.min(i + BATCH, list.length)}/${list.length}（成功 ${done}）\r`);
          if (i + BATCH < list.length) await sleep(BF_DELAY);
        }
        console.log(`\n历史回填完成：${done} 条获得真实成交历史`);
      } catch (e) {
        console.log('历史回填失败（跳过）:', e.message);
      }
    }

    // ---- 每日价格快照 + 可选历史层（均写入 hist.byName: { name: [[dateISO, priceCNY], ...] }） ----
    let hist = fs.existsSync(HIST_FILE) ? JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')) : { byName: {} };
    hist.byName = hist.byName || {};

    // 可选历史层：用你自己的 Steam 会话 Cookie 调 pricehistory 官方端点，一次性补齐真实历史
    // （合规约定：仅使用本人账号会话、仅抓本人可见的公开行情、3s 限流、默认关闭）
    const HIST_N = getArg('history', 0);
    if (HIST_N > 0) {
      const COOKIE = process.env.STEAM_COMMUNITY_COOKIE || '';
      const HIST_USD = args.includes('--hist-usd');   // 你的账号钱包币种为美元时加此开关（默认按人民币口径）
      if (!COOKIE) {
        console.log('未设置 STEAM_COMMUNITY_COOKIE 环境变量，跳过历史抓取（每日快照照常积累）');
      } else {
        const hotNames = Object.keys(cache).filter(n => cache[n].seen === TODAY).slice(0, HIST_N);
        console.log(`历史层：抓取 ${hotNames.length} 个热门物品的 pricehistory（限流 3s）`);
        const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        const toISO = ds => {
          const m = ds.match(/^([A-Z][a-z]{2})\s+(\d+)\s+(\d{4})/);
          if (!m || !(m[1] in MONTHS)) return null;
          return new Date(Date.UTC(+m[3], MONTHS[m[1]], +m[2])).toISOString().slice(0, 10);
        };
        let okH = 0;
        for (const name of hotNames) {
          const url = `https://steamcommunity.com/market/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(name)}`;
          try {
            const out = execFileSync('curl', [
              '-sL', '--max-time', '30',
              '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126',
              '-H', `Cookie: ${COOKIE}`,
              url
            ], { timeout: 40000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
            const j = JSON.parse(out);
            if (j.success && Array.isArray(j.prices)) {
              const byDate = {};
              for (const pr of j.prices) {
                const d = toISO(pr[0]);
                if (d) byDate[d] = HIST_USD ? pr[1] * RATE_EXCHANGE : pr[1];
              }
              const pairs = Object.entries(byDate)
                .sort((a, b) => (a[0] < b[0] ? -1 : 1))
                .map(([d, p]) => [d, Math.round(p * 100) / 100])
                .slice(-HIST_MAX_DAYS);
              const merged = Object.fromEntries(pairs);
              for (const pr of (hist.byName[name] || [])) merged[pr[0]] = pr[1];   // 快照优先
              hist.byName[name] = Object.entries(merged).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-HIST_MAX_DAYS);
              okH++;
            }
          } catch (e) { console.log(`  history fail: ${name.slice(0, 40)} ${e.message}`); }
          await sleep(3000);
        }
        console.log(`历史层完成：${okH}/${hotNames.length}`);
      }
    }

    // 快照合并：本次刷新过的条目记当天价格（同日覆盖）
    for (const name in cache) {
      if (cache[name].seen !== TODAY) continue;
      const row = hist.byName[name] || [];
      const cny = Math.round(cache[name].usd * RATE_EXCHANGE * 100) / 100;
      if (row.length && row[row.length - 1][0] === TODAY) row[row.length - 1][1] = cny;
      else row.push([TODAY, cny]);
      hist.byName[name] = row;
    }
    // refOnly 条目：记录三方最低参考价快照（涨跌逐日变真；同日覆盖）
    let catItems = {};
    if (fs.existsSync(CATALOG_FILE)) {
      try { catItems = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')).items || {}; } catch (e) { catItems = {}; }
      for (const name in catItems) {
        if (cache[name]) continue;   // Steam 条目已在上面记录
        const c = catItems[name];
        const ps = [];
        if (c.skinport && c.skinport.min > 0) ps.push(toCNY(c.skinport.min));
        if (c.mcsgo && c.mcsgo.price > 0) ps.push(toCNY(c.mcsgo.price));
        if (c.waxpeer && c.waxpeer.min > 0) ps.push(toCNY(c.waxpeer.min));
        if (!ps.length) continue;
        const row = hist.byName[name] || [];
        const v = Math.round(Math.min(...ps) * 100) / 100;
        if (row.length && row[row.length - 1][0] === TODAY) row[row.length - 1][1] = v;
        else row.push([TODAY, v]);
        hist.byName[name] = row;
      }
    }
    // 裁剪：移除既不在 Steam 缓存也不在目录并集的条目；每行最多保留 HIST_MAX_DAYS 个点
    for (const name in hist.byName) {
      if (!cache[name] && !catItems[name]) { delete hist.byName[name]; continue; }
      if (hist.byName[name].length > HIST_MAX_DAYS) hist.byName[name] = hist.byName[name].slice(-HIST_MAX_DAYS);
    }
    fs.writeFileSync(HIST_FILE, JSON.stringify(hist));
    console.log(`\n市场总数 ${total}，缓存物品 ${Object.keys(cache).length} 条（本次刷新价格 ${refreshed}）`);
    console.log(`价格快照已写入 ${HIST_FILE}（覆盖 ${Object.keys(hist.byName).length} 个物品）`);
  }

  // 2. 转换为 RAW（按价格降序 = 热门优先，id 递增）；seen=今天 的条目进入热门池（hot=1）
  const entries = Object.values(cache).sort((a, b) => b.usd - a.usd);
  // 第三方参考价附着（目录在磁盘上则 regen 也可用；CNY 换算，字段 sp/mc/wx 分别为 Skinport/market.csgo/Waxpeer）
  let catalogItems = {};
  if (fs.existsSync(CATALOG_FILE)) {
    try { catalogItems = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')).items || {}; } catch (e) {}
  }
  const refOf = c => {
    if (!c) return null;
    const ref = {
      ...(c.skinport && c.skinport.min > 0 ? { sp: toCNY(c.skinport.min) } : {}),
      ...(c.mcsgo && c.mcsgo.price > 0 ? { mc: toCNY(c.mcsgo.price) } : {}),
      ...(c.waxpeer && c.waxpeer.min > 0 ? { wx: toCNY(c.waxpeer.min) } : {})
    };
    return Object.keys(ref).length ? ref : null;
  };
  const RAW = entries.map((e, i) => ({
    id: i + 1,
    name: e.name,
    base: Math.round(e.usd * RATE_EXCHANGE * 100) / 100,   // 真实当前价（CNY）
    rarity: (e.quality || qualityOf(e.type).key),
    cat: e.cat || catOf(e.type, e.name),                   // 武器/收藏品分类
    sil: silOf(e.name, e.cat || catOf(e.type, e.name)),
    hot: e.seen === TODAY ? 1 : 0,                         // 热门池标记（榜单数据源）
    ref: refOf(catalogItems[e.name]),                      // 第三方参考价（可选）
    icon: e.icon,
    imgKey: md5(e.name)
  }));

  // 目录并集中 Steam 尚未采集的条目：以第三方最低参考价占位入库（refOnly）
  // 不进热门池/榜单；搜索可见并标注；深度爬取到同名条目后自动升级为正式 Steam 条目
  const steamNames = new Set(entries.map(e => e.name));
  for (const [name, c] of Object.entries(catalogItems)) {
    if (steamNames.has(name)) continue;
    const ref = refOf(c);
    if (!ref) continue;
    const cat = catFromName(name);
    // 缺失来源用 Infinity 占位，防止 Math.min 被 undefined 拖成 NaN
    const prices = [ref.sp, ref.mc, ref.wx].filter(v => v != null);
    RAW.push({
      name,
      base: Math.round(Math.min(...prices) * 100) / 100,
      rarity: 'common',
      cat,
      sil: silOf(name, cat),
      hot: 0,
      ref,
      ...(c.hist ? { hist: c.hist.a, chgPrev: c.hist.p7 } : {}),
      refOnly: 1,
      imgKey: md5(name)
    });
  }
  RAW.sort((a, b) => b.base - a.base);
  RAW.forEach((e, i) => { e.id = i + 1; });
  // 品质 key 白名单校验（engine RARITY 必须能命中）
  const RARITY_KEYS = new Set(['common', 'mil', 'restr', 'clsfd', 'covert', 'rare', 'contra']);
  for (const e of RAW) if (!RARITY_KEYS.has(e.rarity)) e.rarity = 'common';

  // 3. 价格 Top N 图片下载到本地（走 curl；CDN 无限流，串行即可）；--regen 跳过
  const tops = RAW.slice(0, IMG_TOP);
  let okImg = 0, skipImg = 0;
  if (!REGEN) {
    for (const e of tops) {
      const file = path.join(IMG_DIR, e.imgKey + '.png');
      if (fs.existsSync(file) && fs.statSync(file).size > 3000) { skipImg++; continue; }
      const url = `https://community.cloudflare.steamstatic.com/economy/image/${e.icon}/144fx144`;
      if (curlDownload(url, file)) okImg++;
      else fs.existsSync(file) && fs.unlinkSync(file);
    }
    console.log(`本地图片: 新增 ${okImg} / 已有 ${skipImg} / Top${IMG_TOP}`);
  }

  // 4. 为每个饰品确定 image 字段：本地图片优先，其余走 Steam CDN（运行时加载）
  const CDN = 'https://community.cloudflare.steamstatic.com/economy/image/';
  for (const e of RAW) {
    const f = path.join(IMG_DIR, e.imgKey + '.png');
    e.image = (fs.existsSync(f) && fs.statSync(f).size > 3000)
      ? 'images/' + e.imgKey + '.png'
      : CDN + e.icon + '/144fx144';
  }

  // 5. 生成 data.js（RAW 区块 + 磨损价位库 + 真实历史 + 引擎模板）
  const rawJS = 'const RAW = ' + JSON.stringify(
    RAW.map(({ id, name, base, rarity, cat, sil, hot, ref, refOnly, hist, chgPrev, image }) =>
      refOnly ? { id, name, base, rarity, cat, sil, ref, refOnly, hist, chgPrev, image }
        : ref ? { id, name, base, rarity, cat, sil, hot, ref, image }
          : (hot ? { id, name, base, rarity, cat, sil, hot, image } : { id, name, base, rarity, cat, sil, image })),
    null, 1
  ) + ';';

  const wearDB = buildWearDB(cache);
  const wearJS = 'const WEARDB = ' + JSON.stringify(wearDB, null, 1) + ';';

  let histJS = 'const HISTORY = null;   // 尚无价格历史\n';
  if (fs.existsSync(HIST_FILE)) {
    const hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
    if (hist.byName && Object.keys(hist.byName).length) {
      histJS = 'const HISTORY = ' + JSON.stringify({ byName: hist.byName }) + ';\n';
    }
  }

  let tradeJS = '';
  if (fs.existsSync(TRADEUP_FILE)) {
    try { tradeJS = 'const TRADEUP = ' + fs.readFileSync(TRADEUP_FILE, 'utf8') + ';\n'; } catch (e) {}
  }

  const engineJS = fs.readFileSync(path.join(__dirname, 'crawler-templates', 'engine.js'), 'utf8');

  const data = `/* =====================================================================
 * CS 饰品市场监测 - 数据文件（crawler.js 自动生成，请勿手改）
 * 真实数据来源：Steam 社区市场 API（名称 / 当前最低价 / 品质 / 分类 / 图标）
 * WEARDB[皮肤家族] = { cat, w:普通, st:StatTrak, sv:纪念 } 各磨损真实挂牌价（键 fn/mw/ft/ww/bs/van）
 * HISTORY：每日价格快照（真实历史，每日刷新积累；不足 8 天的条目回退模拟走势）
 * 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}
 * ===================================================================== */
${rawJS}

${wearJS}

${histJS}
${tradeJS}
${engineJS}`;

  // 备份旧 data.js
  if (fs.existsSync(DATA_JS)) fs.copyFileSync(DATA_JS, path.join(CACHE_DIR, 'data.js.bak'));
  fs.writeFileSync(DATA_JS, data);
  console.log(`\n已生成 ${DATA_JS}（${RAW.length} 个饰品，${Object.keys(wearDB).length} 个皮肤家族）`);
  console.log('下一步：node 语法检查 / 重新打包 exe（或把 app/data.js 复制到 exe 同目录启用外置数据）');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

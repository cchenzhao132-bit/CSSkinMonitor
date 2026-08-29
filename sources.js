/**
 * 第三方市场数据源 —— 全部为有公开文档的 API，无密钥，每轮各 1 次请求
 * 用途：物品目录并集 + 「第三方参考价」（Steam 挂牌价仍以 Steam 端点为准，不混用）
 * 合规：遵守各源文档限流（Skinport 8 次/5 分钟，本项目每轮 1 次）；来源在应用内明确标注
 */
const UA = 'cs-skin-monitor/1.0 (open-source price monitor)';

async function getJSON(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Skinport —— https://docs.skinport.com/#items （Node fetch 原生支持 Brotli）
// 字段：market_hash_name / min_price / suggested_price / quantity（USD）
async function skinport() {
  const j = await getJSON('https://api.skinport.com/v1/items?app_id=730&currency=USD');
  const out = {};
  for (const it of j) {
    if (!it.market_hash_name) continue;
    out[it.market_hash_name] = {
      min: it.min_price > 0 ? it.min_price : null,
      suggested: it.suggested_price > 0 ? it.suggested_price : null,
      qty: it.quantity > 0 ? it.quantity : null
    };
  }
  return out;
}

// market.csgo.com —— 公开价格表 https://market.csgo.com/api/v2/prices/USD.json
// 字段：market_hash_name / price / volume（USD）
async function mcsgo() {
  const j = await getJSON('https://market.csgo.com/api/v2/prices/USD.json');
  const out = {};
  for (const it of (j.items || [])) {
    const p = parseFloat(it.price);
    if (!it.market_hash_name || !(p > 0)) continue;
    out[it.market_hash_name] = { price: p, volume: parseInt(it.volume) || null };
  }
  return out;
}

// Waxpeer —— 公开价格 https://api.waxpeer.com/v1/prices?game=csgo
// 注意：min 单位为 0.001 USD，需 /1000
async function waxpeer() {
  const j = await getJSON('https://api.waxpeer.com/v1/prices?game=csgo');
  const out = {};
  for (const it of (j.items || [])) {
    if (!it.name || !(it.min > 0)) continue;
    out[it.name] = { min: it.min / 1000, count: it.count || null };
  }
  return out;
}

const SOURCES = { skinport, mcsgo, waxpeer };

// 逐源抓取，单源失败不影响其他源；返回 { 源名: { market_hash_name: {...} } }
async function fetchAll(log = () => {}) {
  const res = {};
  for (const [name, fn] of Object.entries(SOURCES)) {
    try {
      res[name] = await fn();
      log(`  [source] ${name}: ${Object.keys(res[name]).length} 条`);
    } catch (e) {
      log(`  [source] ${name} 失败（跳过）: ${e.message}`);
    }
  }
  return res;
}

module.exports = { fetchAll };

/**
 * 炼金数据集构建 v2：ByMykel/CSGO-API（Valve 游戏文件的公开社区镜像）→ cache/tradeup.json
 * 双语：en（market_hash_name 匹配价格）+ cn（简体中文显示名）
 * 用法：node build-tradeup.js   （爬虫 --regen 时自动内嵌进 data.js 的 TRADEUP 常量）
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'cache', 'tradeup.json');
const CD = 'https://cdn.jsdelivr.net/gh/ByMykel/CSGO-API@main/public/api/';
const UA = 'cs-skin-monitor/1.0';

async function getJSON(url) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.log(`  attempt ${a} 失败: ${e.message}`);
      if (a === 3) throw e;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

(async () => {
  console.log('下载 skins/crates（en + zh，游戏文件公开镜像，约 40MB）...');
  const skinsEn = await getJSON(CD + 'en/skins.json');
  const skinsZh = await getJSON(CD + 'zh-CN/skins.json');
  const cratesEn = await getJSON(CD + 'en/crates.json');
  const cratesZh = await getJSON(CD + 'zh-CN/crates.json');

  // float 区间 + 中文名（按稳定 id 关联）
  const floats = {}, zhById = {};
  for (const s of skinsEn) if (s.min_float != null && s.max_float != null) floats[s.name] = [s.min_float, s.max_float];
  for (const s of skinsZh) zhById[s.id] = s.name;

  // 稀有度 ID → 档位（游戏文件命名：*_weapon 为枪皮；刀/手套在 contains_rare 金池）
  const TIER = {
    rarity_common_weapon: 'cons', rarity_uncommon_weapon: 'ind', rarity_rare_weapon: 'mil',
    rarity_mythical_weapon: 'restr', rarity_legendary_weapon: 'clsfd', rarity_ancient_weapon: 'cov'
  };
  const mk = it => {
    const f = floats[it.name];
    if (!f) return null;
    return { n: it.name, cn: zhById[it.id] || it.name, f };
  };
  const out = [];
  const zhCrateById = {};
  for (const c of cratesZh) zhCrateById[c.id] = c;
  for (const cr of cratesEn) {
    if (!cr.contains || !cr.contains.length) continue;
    const t = {};
    for (const it of cr.contains) {
      const k = TIER[it.rarity && it.rarity.id];
      if (!k) continue;
      const e = mk(it);
      if (!e) continue;
      (t[k] = t[k] || []).push(e);
    }
    const gold = (cr.contains_rare || []).map(mk).filter(Boolean);
    if (!Object.keys(t).length && !gold.length) continue;
    const zc = zhCrateById[cr.id];
    out.push({
      name: cr.market_hash_name || cr.name,
      cn: (zc && (zc.market_hash_name || zc.name)) || cr.name,
      t, ...(gold.length ? { gold } : {})
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), crates: out }));
  console.log(`已生成 ${OUT}：${out.length} 个集合/武器箱（含金池 ${out.filter(x => x.gold).length} 个）`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

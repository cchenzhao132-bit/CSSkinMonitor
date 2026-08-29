/**
 * 饰品中文名映射：ByMykel/CSGO-API（zh-CN 官方本地化镜像）→ cache/names.json
 * 产出扁平映射 { 英文名: 中文名 }，crawler --regen 时内嵌进 data.js 的 CNAMES 常量
 * 用法：node build-names.js
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'cache', 'names.json');
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

// 各类型端点：en/zh 各拉一份，按稳定 id 关联中文名
const ENDPOINTS = ['skins', 'stickers', 'agents', 'music_kits', 'patches', 'graffiti', 'crates', 'keys'];

(async () => {
  const map = {};
  let types = 0;
  for (const ep of ENDPOINTS) {
    try {
      const en = await getJSON(CD + `en/${ep}.json`);
      const zh = await getJSON(CD + `zh-CN/${ep}.json`);
      const zhName = {};
      for (const it of zh) if (it.id && it.name) zhName[it.id] = it.name;
      let n = 0;
      for (const it of en) {
        const z = zhName[it.id];
        // 优先用市场哈希名做键（与本地数据一致），退化用 name
        const key = it.market_hash_name || it.name;
        if (z && key && !map[key]) { map[key] = z; n++; }
      }
      types++;
      console.log(`  ${ep}: ${n} 条中文名`);
    } catch (e) {
      console.log(`  ${ep} 跳过: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), map }));
  console.log(`已生成 ${OUT}：${Object.keys(map).length} 条中文名（${types} 类）`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

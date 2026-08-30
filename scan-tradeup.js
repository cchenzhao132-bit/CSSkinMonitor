/**
 * 当日炼金雷达：扫描全市场所有 集合×档位 的炼金组合，找出当日最赚 / 最赔配方
 * 数据：cache/tradeup.json（集合与 float 元数据）+ cache/crawler-cache.json（Steam 当日挂牌价）
 *      + cache/catalog.json（第三方参考价）；费率 15%（Steam 卖出按挂牌价 ÷ 1.15 口径）
 * 用法：node scan-tradeup.js  （每日定时任务在 regen 前运行；输出 cache/alch-scan.json）
 */
const fs = require('fs');
const path = require('path');
const CACHE = path.join(__dirname, 'cache');
const RATE = 7.25;
const FEE = 0.15;
const TOP_N = 8;

const wearBandOf = f => f < 0.07 ? 'fn' : f < 0.15 ? 'mw' : f < 0.38 ? 'ft' : f < 0.45 ? 'ww' : 'bs';
const WEAR_MID = { fn: 0.035, mw: 0.11, ft: 0.265, ww: 0.415, bs: 0.725 };
const BANDS = [['fn', 0, 0.07], ['mw', 0.07, 0.15], ['ft', 0.15, 0.38], ['ww', 0.38, 0.45], ['bs', 0.45, 1]];
const WEAR_ZH = { fn: '崭新出厂', mw: '略有磨损', ft: '久经沙场', ww: '破损不堪', bs: '战痕累累' };
const NEXT_TIER = { mil: 'restr', restr: 'clsfd', clsfd: 'cov', cov: 'gold' };
const TIER_ZH = { mil: '军规→受限', restr: '受限→保密', clsfd: '保密→隐秘', cov: '隐秘→金色' };
const clampF = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

(async () => {
  const trade = JSON.parse(fs.readFileSync(path.join(CACHE, 'tradeup.json'), 'utf8'));
  const steamRaw = JSON.parse(fs.readFileSync(path.join(CACHE, 'crawler-cache.json'), 'utf8'));
  const steam = {};
  for (const k in steamRaw) steam[k] = steamRaw[k].usd * RATE;                       // CNY 挂牌价
  const catalog = JSON.parse(fs.readFileSync(path.join(CACHE, 'catalog.json'), 'utf8')).items;
  const refPrice = key => {
    const c = catalog[key];
    if (!c) return null;
    const ps = [c.skinport, c.mcsgo, c.waxpeer].map(x => x && x.min > 0 ? x.min : null).filter(Boolean);
    return ps.length ? Math.min(...ps) * RATE : null;
  };
  // 价格查询：优先 Steam 挂牌，其次三方参考最低
  // 费率口径与前端模拟器一致（d337831 决定）：EV 统一按 挂牌价 ÷ (1+费率) 折成卖方所得，
  // 不按来源区分——ref 价是 Steam 无挂牌时的售价代理，卖出同样在 Steam 市场发生
  const priceOf = (baseName, wearKey, st) => {
    const prefix = st ? (baseName.indexOf('★ ') === 0 ? '★ StatTrak™ ' : 'StatTrak™ ') : '';
    const key = prefix + baseName + ' (' + WEAR_ZH2[wearKey] + ')';
    if (steam[key] > 0) return { price: steam[key], src: 'steam' };
    const rp = refPrice(key);
    return rp ? { price: rp, src: 'ref' } : null;
  };
  const WEAR_ZH2 = { fn: 'Factory New', mw: 'Minimal Wear', ft: 'Field-Tested', ww: 'Well-Worn', bs: 'Battle-Scarred' };
  const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // 产出卖出价（成交口径，抗天价挂牌）：优先 7 日成交中位（Skinport，成交量≥3），
  // 否则 Steam 挂牌与三方 min 的中位数。与前端 alchSalePrice 同口径
  const outPriceOf = (baseName, wearKey, st) => {
    const prefix = st ? (baseName.indexOf('★ ') === 0 ? '★ StatTrak™ ' : 'StatTrak™ ') : '';
    const key = prefix + baseName + ' (' + WEAR_ZH2[wearKey] + ')';
    const c = catalog[key];
    if (c && c.hist && c.hist.p7 > 0) return { price: c.hist.p7, src: 'deal' };
    const steamPr = steam[key] > 0 ? steam[key] : null;
    const ps = [steamPr,
      c && c.skinport && c.skinport.min > 0 ? c.skinport.min * RATE : null,
      c && c.mcsgo && c.mcsgo.price > 0 ? c.mcsgo.price * RATE : null,
      c && c.waxpeer && c.waxpeer.min > 0 ? c.waxpeer.min * RATE : null
    ].filter(v => v > 0);
    return ps.length ? { price: median(ps), src: 'median' } : null;
  };

  const results = [];
  let combos = 0, skipped = 0;
  // 10:1 常规链条只到 保密→隐秘；隐秘→金色 只有 5:1 合同（2025-10 规则），10:1 版本不存在，不扫描
  for (const crate of trade.crates) {
    for (const tier of ['mil', 'restr', 'clsfd']) {
      const pool = crate.t[tier] || [];
      const nextKey = NEXT_TIER[tier];
      const outPool = crate.t[nextKey] || [];
      if (!pool.length || !outPool.length) continue;              // 与前端模拟器一致：单皮肤池也参与（10× 同款合法）

      for (const st of [false, true]) {
        const variants = [];
        for (const p of pool) {
          BANDS.forEach(b => {
            if (Math.max(b[1], p.f[0]) < Math.min(b[2], p.f[1])) {
              const pr = priceOf(p.n, b[0], st);
              if (pr) {
                const fl = clampF(WEAR_MID[b[0]], p.f[0], p.f[1]);
                // 归一化浮动（2024-10 Retakes 规则）：按自身磨损范围映射 0-1；DP 桶轴用归一化值
                const span = p.f[1] - p.f[0];
                const adj = span > 0 ? clampF((fl - p.f[0]) / span, 0, 1) : 0;
                variants.push({ n: p.n, cn: p.cn || p.n, band: b[0], float: fl, adj, price: pr.price, src: pr.src, rb: Math.max(1, Math.round(adj / 0.05)) });
              }
            }
          });
        }
        if (!variants.length) { skipped++; continue; }
        // 产出全都有价才参与（否则 EV 低估会误判最赔）；EV 统一 ÷(1+FEE) 折卖方所得
        // 产出按成交口径（outPriceOf），输入仍按挂牌价（买入即付最低挂牌）
        const evOfAvg = avg => {
          let ev = 0, ok = true;
          for (const o of outPool) {
            const f = o.f[0] + avg * (o.f[1] - o.f[0]);
            const gloves = /Gloves|Glove/.test(o.n);
            const useSt = st && !gloves;
            const pr = outPriceOf(o.n, wearBandOf(f), useSt);
            if (!pr) { ok = false; break; }
            ev += pr.price / (1 + FEE) / outPool.length;
          }
          return ok ? ev : null;
        };
        const NB = 201;
        const dp = Array.from({ length: 11 }, () => Array(NB).fill(null));
        dp[0][0] = { c: 0, prev: null };
        for (let k = 1; k <= 10; k++) {
          for (let b = 0; b < NB; b++) {
            let best = null;
            for (const v of variants) {
              const pb = b - v.rb;
              if (pb < 0 || !dp[k - 1][pb]) continue;
              const c = dp[k - 1][pb].c + v.price;
              if (!best || c < best.c) best = { c, prev: { b: pb, v } };
            }
            dp[k][b] = best;
          }
        }
        const mkRecipe = b => {
          const items = [];
          let cur = b, k = 10;
          while (k > 0 && dp[k][cur]) {
            const prev = dp[k][cur].prev;
            items.push(prev.v);
            cur = prev.b; k--;
          }
          const agg = {};
          items.forEach(v => { const key = v.n + '|' + v.band; (agg[key] = agg[key] || { cn: v.cn, band: v.band, price: v.price, count: 0 }).count++; });
          return Object.values(agg);
        };
        // 全桶扫描最优：同一磨损段内 EV 不变、成本随浮动连续下降，最优在段高端——
        // 旧版只扫段中点，会把转正的最优配方整个漏掉（与前端 alchOptimize 同口径）
        // avg = 归一化平均浮动（2024-10 规则），evOfAvg 将其映射到产出皮肤范围
        let best = null;
        for (let b = 0; b < NB; b++) {
          if (!dp[10][b]) continue;
          const avg = b * 0.05 / 10, cost = dp[10][b].c, ev = evOfAvg(avg);
          if (ev == null || cost <= 0) continue;
          const net = ev - cost;
          if (!best || net > best.net) best = { avg, cost, ev, net, recipe: mkRecipe(b) };
        }
        combos++;
        if (best) results.push({
          crate: crate.name, cn: crate.cn || crate.name, tier, st,
          avg: +best.avg.toFixed(3), cost: +best.cost.toFixed(2), ev: +best.ev.toFixed(2), net: +best.net.toFixed(2),
          roi: best.cost > 0 ? +(best.net / best.cost * 100).toFixed(1) : 0,
          recipe: best.recipe.map(r => ({ cn: r.cn, band: WEAR_ZH[r.band], count: r.count, price: +r.price.toFixed(2) }))
        });
      }
    }
  }

  results.sort((a, b) => b.net - a.net);
  const best = results.slice(0, TOP_N);
  const worst = results.slice(-TOP_N).reverse();
  fs.writeFileSync(path.join(CACHE, 'alch-scan.json'), JSON.stringify({
    updatedAt: new Date().toISOString().slice(0, 10), feePct: 15, combos, skipped,
    best, worst
  }));
  console.log(`扫描完成：${combos} 个组合（跳过 ${skipped}）`);
  console.log('最赚 Top3:');
  best.slice(0, 3).forEach((r, i) => console.log(`  ${i + 1}. [${r.tier}${r.st ? ' ST' : ''}] ${r.cn.slice(0, 30)} 净 ${r.net > 0 ? '+' : ''}${r.net}（成本 ${r.cost}）`));
  console.log('最赔 Top3:');
  worst.slice(0, 3).forEach((r, i) => console.log(`  ${i + 1}. [${r.tier}${r.st ? ' ST' : ''}] ${r.cn.slice(0, 30)} 净 ${r.net}（成本 ${r.cost}）`));
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

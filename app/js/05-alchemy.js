/* =====================================================================
 * 炼金模拟器：价格索引 / 极值公式 DP 扫描 / 双模式渲染
 * ===================================================================== */
'use strict';

  // ---------- 炼金模拟器（Trade-Up，2025-10 规则：10:1 普通 / 5:1 隐秘→刀手套） ----------
  let alchIdx = null;   // baseName → [items]
  function alchIndex() {
    if (alchIdx) return alchIdx;
    const m = {};
    ALL_ITEMS.forEach(i => { (m[famKeyOf(i.name)] = m[famKeyOf(i.name)] || []).push(i); });
    alchIdx = m;
    return m;
  }
  // 皮肤某磨损的价格：Steam 条目优先，其次第三方参考条目
  function alchPrice(baseName, wearKey, st) {
    const prefix = st ? (baseName.indexOf('★ ') === 0 ? '★ StatTrak™ ' : 'StatTrak™ ') : '';
    const want = prefix + baseName + (wearKey === 'van' ? '' : ' (' + WEAR_EN[wearKey] + ')');
    const it = (alchIndex()[baseName] || []).find(i => i.name === want);
    return it ? { price: it.currentPrice, refOnly: !!it.refOnly } : null;
  }
  // 产出卖出价（成交口径，抗天价挂牌）：优先 7 日成交中位（Skinport，成交量≥3 才有），
  // 否则取 Steam 挂牌与三方 min（sp/mc/wx）的中位数——单一来源虚高会被中位吸收
  const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function alchSalePrice(baseName, wearKey, st) {
    const prefix = st ? (baseName.indexOf('★ ') === 0 ? '★ StatTrak™ ' : 'StatTrak™ ') : '';
    const want = prefix + baseName + (wearKey === 'van' ? '' : ' (' + WEAR_EN[wearKey] + ')');
    const it = (alchIndex()[baseName] || []).find(i => i.name === want);
    if (!it) return null;
    const ps = [!it.refOnly ? it.currentPrice : null, it.ref && it.ref.sp, it.ref && it.ref.mc, it.ref && it.ref.wx].filter(v => v > 0);
    const sale = it.p7 > 0 ? it.p7 : (ps.length ? median(ps) : null);
    return sale > 0 ? { price: Math.round(sale * 100) / 100, srcTag: it.p7 > 0 ? '7日成交中位' : '多源中位' } : null;
  }
  const wearBandOf = f => f < 0.07 ? 'fn' : f < 0.15 ? 'mw' : f < 0.38 ? 'ft' : f < 0.45 ? 'ww' : 'bs';
  const WEAR_MID = { fn: 0.035, mw: 0.11, ft: 0.265, ww: 0.415, bs: 0.725 };
  const BANDS = [['fn', 0, 0.07], ['mw', 0.07, 0.15], ['ft', 0.15, 0.38], ['ww', 0.38, 0.45], ['bs', 0.45, 1]];
  const clampF = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 归一化浮动（2024-10 Retakes 更新后的游戏规则）：每个输入先按自身磨损范围映射到 0-1，
  // 平均后再映射到产出皮肤的范围。旧版直接平均原始浮动，在混合不同磨损范围皮肤时全错
  // （如范围 0-0.4 的皮肤浮动 0.30，归一化后按 0.75 计入，而非 0.30）
  const normAdj = (fl, f) => { const span = f[1] - f[0]; return span > 0 ? clampF((fl - f[0]) / span, 0, 1) : 0; };
  const NEXT_TIER = { mil: 'restr', restr: 'clsfd', clsfd: 'cov', cov: 'gold' };
  let alchFloats = null;   // enName → [min,max]
  function alchFloatMap() {
    if (alchFloats) return alchFloats;
    const m = {};
    (typeof TRADEUP !== 'undefined' && TRADEUP && TRADEUP.crates || []).forEach(c => {
      ['cons', 'ind', 'mil', 'restr', 'clsfd', 'cov'].forEach(k => (c.t[k] || []).forEach(e => { m[e.n] = e.f; }));
      (c.gold || []).forEach(e => { m[e.n] = e.f; });
    });
    alchFloats = m;
    return m;
  }

  // 极值公式扫描：DP 求 10 槽在给定平均浮动桶下的最低成本组合
  function alchOptimize(crate, tier, st, fee) {
    const pool = crate.t[tier] || [];
    if (!pool.length) return { note: '该集合在此档位没有皮肤（部分纪念包/武器箱缺少该档位），无法扫描' };
    const variants = [];
    let totalV = 0;   // 全部合法（皮肤×磨损）变体数（含无价被排除的）
    pool.forEach(p => {
      BANDS.forEach(b => {
        if (Math.max(b[1], p.f[0]) < Math.min(b[2], p.f[1])) {
          totalV++;
          const pr = alchPrice(p.n, b[0], st);
          if (pr) {
            const fl = clampF(WEAR_MID[b[0]], p.f[0], p.f[1]);
            variants.push({ n: p.n, cn: p.cn || p.n, band: b[0], float: fl, adj: normAdj(fl, p.f), price: pr.price });
          }
        }
      });
    });
    if (!variants.length) {
      return { note: st
        ? '该档位下没有任何皮肤存在 StatTrak™ 版本价格（老纪念包收藏品通常只有普通/纪念版），无法扫描——可取消 StatTrak 模式后查看'
        : '该档位下没有任何（皮肤×磨损）变体存在价格数据，无法扫描' };
    }
    const nextKey = NEXT_TIER[tier];
    const outPool = nextKey === 'gold' ? (crate.gold || []) : (crate.t[nextKey] || []);
    if (!outPool.length) return { note: '该集合没有下一档产出池，无法扫描' };
    // 产出缺价 → EV 不可信，整桶弃用（与 scan-tradeup.js 口径一致：缺价按 0 计会低估 EV、误判最赚/最赔）
    // 产出按"成交口径"卖出价（alchSalePrice）而非挂牌价——天价挂牌不进 EV
    const evOfAvg = avg => {
      let ev = 0;
      for (const o of outPool) {
        const f = o.f[0] + avg * (o.f[1] - o.f[0]);
        const gloves = /Gloves|Glove/.test(o.n);
        const pr = alchSalePrice(o.n, wearBandOf(f), st && !gloves);
        if (!pr) return null;
        ev += pr.price / outPool.length;
      }
      return ev;
    };
    // DP：dp[k][b] = 前 k 件、归一化浮动和落在桶 b 的最低成本（桶步长 0.05，和上限 10）
    // 桶轴 = 归一化值（游戏按此平均），不是原始浮动
    const STEP = 0.05, NB = 201;
    const vrb = variants.map(v => ({ ...v, rb: Math.max(1, Math.round(v.adj / STEP)) }));
    const dp = Array.from({ length: 11 }, () => Array(NB).fill(null));
    dp[0][0] = { c: 0, prev: null };
    for (let k = 1; k <= 10; k++) {
      for (let b = 0; b < NB; b++) {
        let best = null;
        for (const v of vrb) {
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
      items.forEach(v => { const key = v.n + '|' + v.band; (agg[key] = agg[key] || { cn: v.cn, band: v.band, float: v.float, price: v.price, count: 0 }).count++; });
      return Object.values(agg);
    };
    const evalB = b => {
      if (!dp[10][b]) return null;
      const avg = b * STEP / 10;   // 归一化平均浮动（游戏语义）
      const ev = evOfAvg(avg);
      if (ev === null) return null;   // 该浮动下产出有缺价 → EV 不可信
      const cost = dp[10][b].c;
      // 与主面板同口径：卖方所得 = 挂牌价 ÷ (1+费率)
      return { avg, cost, ev, net: ev / (1 + fee / 100) - cost, recipe: mkRecipe(b) };
    };
    let best = null, worst = null, minF = null, maxF = null;
    // 全桶扫描最赚/最赔：同一磨损段内 EV 不变，但成本随浮动连续下降，
    // 故每段最优在「段的高端」（贴近下一磨损档边界），而非段中点。
    // （旧实现只扫段中点，会把正收益的最优配方整个漏掉，误报「全场无正收益」）
    for (let b = 0; b < NB; b++) {
      const r = evalB(b);
      if (!r) continue;
      if (!best || r.net > best.net) best = r;
      if (!worst || r.net < worst.net) worst = r;
    }
    for (let b = 0; b < NB && minF === null; b++) if (dp[10][b]) minF = evalB(b);
    for (let b = NB - 1; b >= 0 && maxF === null; b--) if (dp[10][b]) maxF = evalB(b);
    if (!best && !worst && !minF && !maxF) {
      return { note: st
        ? '产出池中存在无 StatTrak™ 版本价格的皮肤，EV 无法可信估计，已跳过扫描——可取消 StatTrak 模式后查看'
        : '产出池中存在无价格数据的皮肤，EV 无法可信估计，已跳过扫描' };
    }
    return { best, worst, minF, maxF, scanned: variants.length, totalV };
  }

  function renderAlchemy() {
    const A = state.alch;
    const crates = (typeof TRADEUP !== 'undefined' && TRADEUP && TRADEUP.crates) ? TRADEUP.crates : [];
    if (!crates.length) {
      app.innerHTML = '<div class="back-bar"><button class="back-btn" id="alchBackBtn">← 返回榜单</button></div>' +
        '<div class="no-result"><div class="nr-title">⚗ 炼金数据未就绪</div><div class="nr-desc">先运行 <b>node build-tradeup.js</b> 生成炼金数据集，再执行 <b>node crawler.js --regen</b> 重建数据文件</div></div>';
      $('#alchBackBtn').addEventListener('click', goBack);
      return;
    }
    if (A.crate == null || A.crate >= crates.length) A.crate = 0;
    const crate = crates[A.crate];
    const is5 = A.mode === '5';
    // 10:1 常规链条只到 保密→隐秘；隐秘→金色 只有 5:1 合同（2025-10 规则），无 10:1 版本
    const TIERS10 = ['mil', 'restr', 'clsfd'];
    // 切换集合后当前档位可能不存在（如纪念包缺档位）→ 自动回退到首个有效档位
    if (!is5) {
      const tierOk = t => (crate.t[t] || []).length;
      if (!tierOk(A.tier) || !TIERS10.includes(A.tier)) A.tier = TIERS10.find(tierOk) || 'mil';
    }
    const tier = is5 ? 'cov' : A.tier;
    const nSlots = is5 ? 5 : 10;
    const pool = crate.t[tier] || [];
    const firstCovCrate = () => { const i = crates.findIndex(c => (c.t.cov || []).length); return i < 0 ? 0 : i; };

    while (A.slots.length < nSlots) A.slots.push(null);
    A.slots.length = nSlots;
    A.slots.forEach((s, i) => {
      if (s && s.name && s.float != null && !s.manual) {
        if (is5) { if (crates[s.ci] && (crates[s.ci].t.cov || []).some(p => p.n === s.name)) return; }
        else if (pool.some(p => p.n === s.name)) return;
      }
      const ci = is5 ? ((crates[A.crate].t.cov || []).length ? A.crate : firstCovCrate()) : A.crate;
      const pp = crates[ci].t[tier] || [];
      const p0 = pp[0];
      A.slots[i] = { ci, name: p0 ? p0.n : '', wear: 'ft', float: p0 ? clampF(WEAR_MID.ft, p0.f[0], p0.f[1]) : 0.25, manual: false, mprice: null };
    });
    const cn2en = {};   // 手动模式按中文名输入时也能解析出英文库名查价
    crates.forEach(c => { Object.values(c.t).flat().concat(c.gold || []).forEach(e => { if (e.cn) cn2en[e.cn] = e.n; }); });
    const resolveN = n => cn2en[n] || n;   // 中文名 → 英文库名（已是英文名则原样返回）
    const slotPrice = s => s.manual
      ? (s.mprice != null ? { price: s.mprice, refOnly: false } : (alchPrice(resolveN(s.name), s.wear, A.st)))
      : alchPrice(s.name, s.wear, A.st);

    const slotHtml = (s, i) => {
      const sPool = is5 ? (crates[s.ci].t.cov || []) : pool;
      const p = sPool.find(x => x.n === resolveN(s.name)) || sPool[0];
      const f0 = p ? p.f[0] : 0, f1 = p ? p.f[1] : 1;
      const wearOpts = BANDS.filter(b => Math.max(b[1], f0) < Math.min(b[2], f1))
        .map(b => `<option value="${b[0]}" ${s.wear === b[0] ? 'selected' : ''}>${WEAR_ZH[b[0]]}</option>`).join('');
      const pr = slotPrice(s);
      const cnOf = x => { const e = sPool.find(y => y.n === x); return (e && e.cn) || x; };
      const nameCell = s.manual
        ? `<input class="alch-mname" data-i="${i}" list="alchDl" value="${esc(s.name)}" placeholder="输入皮肤名（英文）" title="中文名可在下拉中选择；价格请手动填写">`
        : `<select class="alch-skin" data-i="${i}">${sPool.map(pp => `<option value="${esc(pp.n)}" ${pp.n === s.name ? 'selected' : ''}>${esc(pp.cn || pp.n)}</option>`).join('')}</select>`;
      const priceCell = s.manual
        ? `<input class="alch-mprice" data-i="${i}" type="number" step="0.01" min="0" value="${s.mprice != null ? s.mprice : ''}" placeholder="单价 ¥">`
        : `<span class="alch-slot-price">${pr ? fmt(pr.price) : '—'}</span>`;
      const crateSel = is5 ? `<select class="alch-crate" data-i="${i}">${crates.map((c, ci) => ((c.t.cov || []).length && c.gold) ? `<option value="${ci}" ${s.ci === ci ? 'selected' : ''}>${esc(c.cn || c.name)}</option>` : '').join('')}</select>` : '';
      return `
        <div class="alch-slot ${s.manual ? 'alch-slot-manual' : ''}">
          <span class="alch-idx">${i + 1}</span>
          ${crateSel}
          ${nameCell}
          <select class="alch-wear" data-i="${i}">${wearOpts}</select>
          <input class="alch-float" data-i="${i}" type="number" min="${f0}" max="${f1}" step="0.0001" value="${(+s.float).toFixed(4)}" title="输入浮动值">
          ${priceCell}
          <button class="alch-manual ${s.manual ? 'on' : ''}" data-i="${i}" title="切换手动输入（名称+价格）">✎</button>
        </div>`;
    };

    const avgF = A.slots.reduce((s, x) => s + (+x.float || 0), 0) / (A.slots.length || 1);
    // 归一化平均（2024-10 规则）：每个槽位按自身皮肤磨损范围映射 0-1 后取平均
    const slotFRange = s => (alchFloatMap()[resolveN(s.name)] || [0, 1]);
    const avgAdj = A.slots.reduce((s, x) => s + normAdj(+x.float || 0, slotFRange(x)), 0) / (A.slots.length || 1);
    let cost = 0, costUnknown = 0;
    A.slots.forEach(s => {
      const p = slotPrice(s);
      if (p) cost += p.price; else costUnknown++;
    });
    let outcomes = [];
    if (is5) {
      const groups = {};
      A.slots.forEach(s => { if (s.name) (groups[s.ci] = groups[s.ci] || []).push(s); });
      for (const ci in groups) {
        let g = crates[ci].gold || [];
        // StatTrak 5:1 合同只出 StatTrak 刀（ST 手套不存在）→ ST 模式下手套整个移出产出池
        if (A.st) g = g.filter(o => !/Gloves|Glove/.test(o.n));
        if (!g.length) continue;
        const w = groups[ci].length / 5;
        g.forEach(o => outcomes.push({ name: o.n, cn: o.cn, f: o.f, prob: w / g.length }));
      }
    } else {
      const nextKey = NEXT_TIER[tier];
      const outPool = nextKey === 'gold' ? (crate.gold || []) : (crate.t[nextKey] || []);
      outcomes = outPool.map(o => ({ name: o.n, cn: o.cn, f: o.f, prob: 1 / outPool.length }));
    }
    const rows = outcomes.map(o => {
      const outF = o.f[0] + avgAdj * (o.f[1] - o.f[0]);   // 归一化均值映射到产出皮肤范围
      const w = wearBandOf(outF);
      const gloves = /Gloves|Glove/.test(o.name);
      const st = A.st && !gloves;
      const pr = alchSalePrice(o.name, w, st);   // 卖出价用成交口径，买入价（槽位）仍按挂牌
      return { name: o.name, cn: o.cn || o.name, prob: o.prob, outF, w, pr, stOff: A.st && gloves };
    }).sort((a, b) => b.prob - a.prob || (b.pr ? b.pr.price : 0) - (a.pr ? a.pr.price : 0));
    const priced = rows.filter(r => r.pr);
    const ev = priced.reduce((s, r) => s + r.prob * r.pr.price, 0);
    // Steam 费按"卖方所得 = 挂牌价 ÷ (1+费率)"口径（官方 5%+10% ≈ 15%）
    const net = A.feeOn ? ev / (1 + A.feePct / 100) - cost : ev - cost;
    const roi = cost > 0 ? net / cost * 100 : 0;
    // 存在无价槽位时成本被少计，净收益必然虚高 → 不显示数字，与扫描器「缺价不参与」口径一致
    const netTrusted = costUnknown === 0;
    const evPartial = priced.length < rows.length;   // 部分产出缺价 → EV 低估

    // 极值公式扫描（仅 10:1；5:1 组合空间不同）
    let optHtml = '';
    if (!is5) {
      const opt = alchOptimize(crate, tier, A.st, A.feeOn ? A.feePct : 0);
      if (opt && opt.note) {
        // 无法可信扫描（如 ST 模式遇老纪念包收藏品、产出缺价）：给出原因，不再静默消失
        optHtml = `
          <section class="chart-card">
            <div class="chart-head"><div class="chart-title"><span class="dot dot-ref"></span>极值公式扫描</div></div>
            <div class="wear-hint" style="padding:0 12px 10px">⚗ ${esc(opt.note)}。</div>
          </section>`;
      } else if (opt && (opt.best || opt.worst || opt.minF || opt.maxF)) {
        const card = (title, r, cls) => {
          if (!r) return '';
          const recipe = r.recipe.map(x => `${x.count}× ${esc(x.cn)}（${WEAR_ZH[x.band]}）`).join(' + ');
          return `<div class="alch-ext ${cls || ''}">
            <div class="alch-ext-title">${title}</div>
            <div class="alch-ext-num">归一化均值 ${r.avg.toFixed(3)} · 成本 ${fmt(r.cost)} · EV ${fmt(r.ev)} · <b class="${r.net > 0 ? 'up-c' : 'down-c'}">${fmtSigned(r.net)}</b></div>
            <div class="alch-ext-recipe">${recipe}</div>
          </div>`;
        };
        // 全场皆亏时如实标注，避免「最赚」却显示负数的观感矛盾
        const bestTitle = opt.best && opt.best.net > 0 ? '最赚公式' : '亏得最少（全场无正收益）';
        optHtml = `
          <section class="chart-card">
            <div class="chart-head"><div class="chart-title"><span class="dot dot-ref"></span>极值公式扫描</div>
              <span class="wear-hint">在该集合该档位下，穷举 10 槽浮动与皮肤组合的最低成本路径 · 扫描 ${opt.scanned} 个（皮肤×磨损）变体${opt.totalV > opt.scanned ? ` · ${opt.totalV - opt.scanned} 个无价变体未参与` : ''}</span></div>
            <div class="alch-ext-grid">
              ${card(bestTitle, opt.best, 'alch-ext-best')}
              ${card('最赔公式', opt.worst, 'alch-ext-worst')}
              ${card('产出浮动最小', opt.minF)}
              ${card('产出浮动最大', opt.maxF)}
            </div>
            <div class="wear-hint" style="padding:0 12px 10px">归一化均值 = 每个输入按自身磨损范围映射 0-1 后的平均值（2024-10 规则）；产出浮动最小/最大 = 可实现的最低/最高归一化均值；最赚/最赔 = 该水平下成本最低配方的净收益。产出存在缺价时该浮动段不参与（缺价按 0 计会低估 EV）。当所有配方净收益为负，「亏得最少」仅是损失最小的选择，不代表能盈利。</div>
          </section>`;
      }
    }

    // 今日炼金雷达（每日定时扫描：全市场 集合×档位 极值配方，点击行载入模拟器）
    let scanHtml = '';
    const SCAN = (typeof ALCHSCAN !== 'undefined' && ALCHSCAN && ALCHSCAN.best && ALCHSCAN.best.length) ? ALCHSCAN : null;
    if (SCAN) {
      const scanTable = (list, rowCls) => `
        <table class="wear-table alch-scan-table">
          <thead><tr><th>#</th><th>集合 / 路线</th><th>归一化均值</th><th>成本</th><th>EV</th><th>净收益</th><th>ROI</th></tr></thead>
          <tbody>
            ${list.map((r, i) => `
              <tr class="alch-scan-row ${rowCls}" data-crate="${esc(r.crate)}" data-tier="${r.tier}" data-st="${r.st ? 1 : 0}" title="点击载入模拟器细调">
                <td class="mono">${i + 1}</td>
                <td class="w-name">${esc(r.cn)}<span class="w-en">${({ mil: '军规→受限', restr: '受限→保密', clsfd: '保密→隐秘', cov: '隐秘→金色' }[r.tier] || '')}${r.st ? ' · StatTrak' : ''}</span></td>
                <td class="mono">${r.avg.toFixed(3)}</td>
                <td class="mono">${fmt(r.cost)}</td>
                <td class="mono">${fmt(r.ev)}</td>
                <td><span class="w-price ${r.net > 0 ? 'up-c' : 'down-c'}">${r.net > 0 ? '+' : ''}${fmt(r.net)}</span></td>
                <td class="mono">${r.roi > 0 ? '+' : ''}${r.roi}%</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      scanHtml = `
        <section class="chart-card alch-scan">
          <div class="chart-head"><div class="chart-title"><span class="dot dot-ref"></span>今日炼金雷达
            <span class="wear-hint">${SCAN.updatedAt} · 扫描 ${SCAN.combos} 个 集合×档位 组合 · 净收益已含 15% 市场费 · 产出按 7 日成交中位/多源中位价（抗天价挂牌），输入按挂牌价 · 纪念收藏按普通（非纪念品）版本计价，Souvenir 皮肤不可汰换 · 点击行载入模拟器</span></div></div>
          <div class="alch-scan-grid">
            <div><div class="alch-scan-title up-c">▲ 最赚配方 Top ${SCAN.best.length}</div>${scanTable(SCAN.best, 'alch-scan-best')}</div>
            <div><div class="alch-scan-title down-c">▼ 最赔配方 Top ${SCAN.worst.length}</div>${scanTable(SCAN.worst, 'alch-scan-worst')}</div>
          </div>
        </section>`;
    }

    app.innerHTML = `
      <div class="back-bar">
        <button class="back-btn" id="alchBackBtn">← 返回榜单</button>
        <span style="font-size:12px;color:var(--text-faint)">炼金模拟器 · 规则：2024-10 归一化浮动 + 2025-10 扩展（10:1 普通至 保密→隐秘 / 5:1 隐秘→刀手套）· 集合数据：游戏文件公开镜像</span>
      </div>
      ${scanHtml}
      ${/Souvenir/.test(crate.name) ? `<div class="alch-svn-warn">⚠ 纪念品（Souvenir）皮肤<strong>不能</strong>作为汰换合同输入（Valve 规则）。本页按同收藏品的<strong>普通（非纪念品）版本</strong>价格计算——实际买入时务必确认不是 Souvenir 前缀的纪念品。</div>` : ''}
      <section class="chart-card alch-panel">
        <div class="alch-row">
          <div class="alch-seg">
            <button class="chip ${A.mode === '10' ? 'active' : ''}" data-mode="10">10:1 普通升级</button>
            <button class="chip ${A.mode === '5' ? 'active' : ''}" data-mode="5">5:1 刀具/手套</button>
          </div>
          <select class="alch-crate-main" id="alchCrate">${crates.map((c, ci) => `<option value="${ci}" ${A.crate === ci ? 'selected' : ''}>${esc(c.cn || c.name)}</option>`).join('')}</select>
          ${is5 ? '' : `<div class="alch-seg">${TIERS10.map(t => {
            const ok = (crate.t[t] || []).length;
            return `<button class="chip ${A.tier === t ? 'active' : ''}" data-tier="${t}" ${ok ? '' : 'disabled title="该集合无此档位"'}>${{ mil: '军规→受限', restr: '受限→保密', clsfd: '保密→隐秘' }[t]}</button>`;
          }).join('')}</div>`}
        </div>
        <div class="alch-row alch-opts">
          <label class="alch-opt"><input type="checkbox" id="alchST" ${A.st ? 'checked' : ''}> StatTrak 模式（须全 ST 输入 → ST 产出；手套除外）</label>
          <label class="alch-opt"><input type="checkbox" id="alchFee" ${A.feeOn ? 'checked' : ''}> 计入市场费</label>
          <input class="alch-feepct" id="alchFeePct" type="number" min="0" max="30" step="0.5" value="${A.feePct}" title="Steam 卖出综合费率（挂牌价 ÷ (1+费率) 为实际到手）">%
          <span class="wear-hint">产出浮动 = 产出min + 归一化均值 × (产出max − min)，归一化 = 每个输入按自身磨损范围映射 0-1 再平均（2024-10 规则）· 磨损档默认档位中值，可手动改 · 每槽 ✎ 可手动输入皮肤与单价</span>
        </div>
        <div class="alch-slots" id="alchWrap">${A.slots.map((s, i) => slotHtml(s, i)).join('')}</div>
        <datalist id="alchDl">${crates.flatMap(c => [...Object.values(c.t).flat(), ...(c.gold || [])]).map(e => `<option value="${esc(e.n)}">${esc(e.cn || e.n)}</option>`).join('')}</datalist>
      </section>
      <section class="alch-summary">
        <div class="stat-card"><span class="stat-label">输入成本（${nSlots} 件${costUnknown ? ` · ${costUnknown} 件无价未计入` : ''}）</span><span class="stat-value">${fmt(cost)}</span></div>
        <div class="stat-card"><span class="stat-label">平均输入浮动（归一化）</span><span class="stat-value">${avgF.toFixed(4)}（${avgAdj.toFixed(3)}）</span></div>
        <div class="stat-card"><span class="stat-label">期望产出 EV${evPartial ? '（部分产出缺价·低估）' : '（成交口径）'}</span><span class="stat-value">${fmt(ev)}</span></div>
        <div class="stat-card"><span class="stat-label">净收益 ${A.feeOn ? `（含 ${A.feePct}% 费）` : ''}</span><span class="stat-value ${netTrusted ? (net > 0 ? 'up-c' : 'down-c') : ''}">${netTrusted ? `${fmtSigned(net)}（${roi.toFixed(1)}%）` : `—（${costUnknown} 件槽位无价，净收益不可信）`}</span></div>
      </section>
      ${optHtml}
      <section class="chart-card">
        <div class="chart-head"><div class="chart-title"><span class="dot"></span>可能产出（共 ${rows.length} 种${priced.length < rows.length ? ` · ${rows.length - priced.length} 种无价格数据，不计入 EV` : ''}）</div></div>
        <table class="wear-table">
          <thead><tr><th>可能产出</th><th>概率</th><th>产出浮动</th><th>磨损</th><th>卖出参考价</th><th>价格来源</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="w-name">${esc(r.cn)}<span class="w-en">${esc(r.name)}</span>${r.stOff ? '<span class="w-en">（手套不适用 ST，按普通版计价）</span>' : ''}</td>
                <td class="mono">${(r.prob * 100).toFixed(1)}%</td>
                <td class="mono">${r.outF.toFixed(4)}</td>
                <td>${WEAR_ZH[r.w]}</td>
                <td>${r.pr ? `<span class="w-price">${fmt(r.pr.price)}</span>` : '—'}</td>
                <td>${r.pr ? esc(r.pr.srcTag || '') : '<span style="color:var(--text-faint)">无数据</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`;

    app.querySelectorAll('.alch-scan-row').forEach(tr => tr.addEventListener('click', () => {
      const ci = crates.findIndex(c => c.name === tr.dataset.crate);
      if (ci < 0) return;
      A.mode = '10'; A.crate = ci; A.tier = tr.dataset.tier; A.st = tr.dataset.st === '1'; A.slots = [];
      renderAlchemy();
    }));
    $('#alchBackBtn').addEventListener('click', goBack);
    $('#alchCrate').addEventListener('change', e => { A.crate = +e.target.value; A.slots = []; renderAlchemy(); });
    app.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { A.mode = b.dataset.mode; A.slots = []; renderAlchemy(); }));
    app.querySelectorAll('[data-tier]').forEach(b => b.addEventListener('click', () => { if (!b.disabled) { A.tier = b.dataset.tier; A.slots = []; renderAlchemy(); } }));
    $('#alchST').addEventListener('change', e => { A.st = e.target.checked; renderAlchemy(); });
    $('#alchFee').addEventListener('change', e => { A.feeOn = e.target.checked; renderAlchemy(); });
    $('#alchFeePct').addEventListener('change', e => { A.feePct = clampF(+e.target.value || 15, 0, 30); renderAlchemy(); });
    const wrap = $('#alchWrap');
    wrap.addEventListener('change', e => {
      const i = +e.target.dataset.i;
      if (isNaN(i)) return;
      const s = A.slots[i];
      const sPool = is5 ? (crates[s.ci].t.cov || []) : pool;
      const cur = sPool.find(x => x.n === resolveN(s.name)) || sPool[0];
      if (e.target.classList.contains('alch-manual')) {
        s.manual = !s.manual;
        if (s.manual && s.mprice == null) { const p = alchPrice(resolveN(s.name), s.wear, A.st); s.mprice = p ? p.price : null; }
        renderAlchemy();
      } else if (e.target.classList.contains('alch-crate')) {
        s.ci = +e.target.value;
        const np = (crates[s.ci].t.cov || [])[0];
        if (np) { s.name = np.n; s.float = clampF(WEAR_MID[s.wear], np.f[0], np.f[1]); }
        renderAlchemy();
      } else if (e.target.classList.contains('alch-skin')) {
        s.name = e.target.value;
        const np = sPool.find(x => x.n === s.name);
        if (np) s.float = clampF(WEAR_MID[s.wear], np.f[0], np.f[1]);
        renderAlchemy();
      } else if (e.target.classList.contains('alch-mname')) {
        s.name = e.target.value.trim();
        const fm = alchFloatMap()[resolveN(s.name)];
        if (fm) s.float = clampF(WEAR_MID[s.wear], fm[0], fm[1]);
        renderAlchemy();
      } else if (e.target.classList.contains('alch-mprice')) {
        s.mprice = e.target.value === '' ? null : +e.target.value;
        renderAlchemy();
      } else if (e.target.classList.contains('alch-wear')) {
        s.wear = e.target.value;
        if (cur) s.float = clampF(WEAR_MID[s.wear], cur.f[0], cur.f[1]);
        renderAlchemy();
      } else if (e.target.classList.contains('alch-float')) {
        s.float = clampF(+e.target.value || 0, cur ? cur.f[0] : 0, cur ? cur.f[1] : 1);
        renderAlchemy();
      }
    });
  }

  // 事件委托：星标收藏 / 行点击 / 无结果入口点击（榜单、搜索、收藏页共用）
  function wireListDelegation() {
    const list = $('#itemList');
    if (!list) return;
    list.addEventListener('click', e => {
      const fb = e.target.closest('.fav-btn');
      if (fb) {
        const on = toggleFav(fb.dataset.name);
        if (state.route.page === 'fav') { renderFavs(); return; }   // 收藏页取消收藏 → 移除该行
        fb.classList.toggle('on', on);
        fb.textContent = on ? '★' : '☆';
        return;
      }
      const row = e.target.closest('.item-row');
      if (row) { goDetail(+row.dataset.id); return; }
      const entry = e.target.closest('.nr-entry');
      if (entry) goDetail(+entry.dataset.id);
    });
  }

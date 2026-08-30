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
  const wearBandOf = f => f < 0.07 ? 'fn' : f < 0.15 ? 'mw' : f < 0.38 ? 'ft' : f < 0.45 ? 'ww' : 'bs';
  const WEAR_MID = { fn: 0.035, mw: 0.11, ft: 0.265, ww: 0.415, bs: 0.725 };
  const BANDS = [['fn', 0, 0.07], ['mw', 0.07, 0.15], ['ft', 0.15, 0.38], ['ww', 0.38, 0.45], ['bs', 0.45, 1]];
  const clampF = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
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
    const variants = [];
    let totalV = 0;   // 全部合法（皮肤×磨损）变体数（含无价被排除的）
    pool.forEach(p => {
      BANDS.forEach(b => {
        if (Math.max(b[1], p.f[0]) < Math.min(b[2], p.f[1])) {
          totalV++;
          const pr = alchPrice(p.n, b[0], st);
          if (pr) variants.push({ n: p.n, cn: p.cn || p.n, band: b[0], float: clampF(WEAR_MID[b[0]], p.f[0], p.f[1]), price: pr.price });
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
    const evOfAvg = avg => {
      let ev = 0;
      for (const o of outPool) {
        const f = o.f[0] + avg * (o.f[1] - o.f[0]);
        const gloves = /Gloves|Glove/.test(o.n);
        const pr = alchPrice(o.n, wearBandOf(f), st && !gloves);
        if (!pr) return null;
        ev += pr.price / outPool.length;
      }
      return ev;
    };
    // DP：dp[k][b] = 前 k 件、浮动和落在桶 b 的最低成本（桶步长 0.05，和上限 10）
    const STEP = 0.05, NB = 201;
    const vrb = variants.map(v => ({ ...v, rb: Math.max(1, Math.round(v.float / STEP)) }));
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
      const ev = evOfAvg(b * STEP / 10);
      if (ev === null) return null;   // 该浮动下产出有缺价 → EV 不可信
      const avg = b * STEP / 10, cost = dp[10][b].c;
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
    const slotPrice = s => s.manual
      ? (s.mprice != null ? { price: s.mprice, refOnly: false } : (alchPrice(cn2en[s.name] || s.name, s.wear, A.st)))
      : alchPrice(s.name, s.wear, A.st);

    const slotHtml = (s, i) => {
      const sPool = is5 ? (crates[s.ci].t.cov || []) : pool;
      const p = sPool.find(x => x.n === s.name) || sPool[0];
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
        const g = crates[ci].gold || [];
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
      const outF = o.f[0] + avgF * (o.f[1] - o.f[0]);
      const w = wearBandOf(outF);
      const gloves = /Gloves|Glove/.test(o.name);
      const st = A.st && !gloves;
      const pr = alchPrice(o.name, w, st);
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
            <div class="alch-ext-num">平均浮动 ${r.avg.toFixed(3)} · 成本 ${fmt(r.cost)} · EV ${fmt(r.ev)} · <b class="${r.net > 0 ? 'up-c' : 'down-c'}">${fmtSigned(r.net)}</b></div>
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
            <div class="wear-hint" style="padding:0 12px 10px">产出浮动最小/最大 = 可实现的最低/最高平均输入浮动；最赚/最赔 = 该浮动水平下成本最低配方的净收益。产出存在缺价时该浮动段不参与（缺价按 0 计会低估 EV）。当所有配方净收益为负，「亏得最少」仅是损失最小的选择，不代表能盈利。</div>
          </section>`;
      }
    }

    app.innerHTML = `
      <div class="back-bar">
        <button class="back-btn" id="alchBackBtn">← 返回榜单</button>
        <span style="font-size:12px;color:var(--text-faint)">炼金模拟器 · 规则：2025-10 更新（10:1 普通 / 5:1 隐秘→刀手套）· 集合数据：游戏文件公开镜像</span>
      </div>
      <section class="chart-card alch-panel">
        <div class="alch-row">
          <div class="alch-seg">
            <button class="chip ${A.mode === '10' ? 'active' : ''}" data-mode="10">10:1 普通升级</button>
            <button class="chip ${A.mode === '5' ? 'active' : ''}" data-mode="5">5:1 刀具/手套</button>
          </div>
          <select class="alch-crate-main" id="alchCrate">${crates.map((c, ci) => `<option value="${ci}" ${A.crate === ci ? 'selected' : ''}>${esc(c.cn || c.name)}</option>`).join('')}</select>
          ${is5 ? '' : `<div class="alch-seg">${['mil', 'restr', 'clsfd', 'cov'].map(t => {
            const ok = (crate.t[t] || []).length && (t !== 'cov' || (crate.gold || []).length);
            return `<button class="chip ${A.tier === t ? 'active' : ''}" data-tier="${t}" ${ok ? '' : 'disabled title="该集合无此档位或金池"'}>${{ mil: '军规→受限', restr: '受限→保密', clsfd: '保密→隐秘', cov: '隐秘→金色' }[t]}</button>`;
          }).join('')}</div>`}
        </div>
        <div class="alch-row alch-opts">
          <label class="alch-opt"><input type="checkbox" id="alchST" ${A.st ? 'checked' : ''}> StatTrak 模式（须全 ST 输入 → ST 产出；手套除外）</label>
          <label class="alch-opt"><input type="checkbox" id="alchFee" ${A.feeOn ? 'checked' : ''}> 计入市场费</label>
          <input class="alch-feepct" id="alchFeePct" type="number" min="0" max="30" step="0.5" value="${A.feePct}" title="Steam 卖出综合费率（挂牌价 ÷ (1+费率) 为实际到手）">%
          <span class="wear-hint">产出浮动 = min + 平均输入浮动 × (max − min) · 磨损档默认档位中值，可手动改 · 每槽 ✎ 可手动输入皮肤与单价</span>
        </div>
        <div class="alch-slots" id="alchWrap">${A.slots.map((s, i) => slotHtml(s, i)).join('')}</div>
        <datalist id="alchDl">${crates.flatMap(c => [...Object.values(c.t).flat(), ...(c.gold || [])]).map(e => `<option value="${esc(e.n)}">${esc(e.cn || e.n)}</option>`).join('')}</datalist>
      </section>
      <section class="alch-summary">
        <div class="stat-card"><span class="stat-label">输入成本（${nSlots} 件${costUnknown ? ` · ${costUnknown} 件无价未计入` : ''}）</span><span class="stat-value">${fmt(cost)}</span></div>
        <div class="stat-card"><span class="stat-label">平均输入浮动</span><span class="stat-value">${avgF.toFixed(4)}</span></div>
        <div class="stat-card"><span class="stat-label">期望产出 EV${evPartial ? '（部分产出缺价·低估）' : ''}</span><span class="stat-value">${fmt(ev)}</span></div>
        <div class="stat-card"><span class="stat-label">净收益 ${A.feeOn ? `（含 ${A.feePct}% 费）` : ''}</span><span class="stat-value ${netTrusted ? (net > 0 ? 'up-c' : 'down-c') : ''}">${netTrusted ? `${fmtSigned(net)}（${roi.toFixed(1)}%）` : `—（${costUnknown} 件槽位无价，净收益不可信）`}</span></div>
      </section>
      ${optHtml}
      <section class="chart-card">
        <div class="chart-head"><div class="chart-title"><span class="dot"></span>可能产出（共 ${rows.length} 种${priced.length < rows.length ? ` · ${rows.length - priced.length} 种无价格数据，不计入 EV` : ''}）</div></div>
        <table class="wear-table">
          <thead><tr><th>可能产出</th><th>概率</th><th>产出浮动</th><th>磨损</th><th>参考价</th><th>价格来源</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="w-name">${esc(r.cn)}<span class="w-en">${esc(r.name)}</span>${r.stOff ? '<span class="w-en">（手套不适用 ST，按普通版计价）</span>' : ''}</td>
                <td class="mono">${(r.prob * 100).toFixed(1)}%</td>
                <td class="mono">${r.outF.toFixed(4)}</td>
                <td>${WEAR_ZH[r.w]}</td>
                <td>${r.pr ? `<span class="w-price">${fmt(r.pr.price)}</span>` : '—'}</td>
                <td>${r.pr ? (r.pr.refOnly ? '第三方' : 'Steam') : '<span style="color:var(--text-faint)">无数据</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`;

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
      const cur = sPool.find(x => x.n === s.name) || sPool[0];
      if (e.target.classList.contains('alch-manual')) {
        s.manual = !s.manual;
        if (s.manual && s.mprice == null) { const p = alchPrice(s.name, s.wear, A.st); s.mprice = p ? p.price : null; }
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
        const fm = alchFloatMap()[s.name];
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

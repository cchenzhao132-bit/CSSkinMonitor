/* =====================================================================
 * CS 饰品市场监测 - 应用逻辑
 * 单页应用：榜单页（涨/跌） <-> 详情页；hash 路由；搜索防抖
 * ===================================================================== */
(function () {
  'use strict';

  // ---------- 全局状态 ----------
  const state = {
    route: { page: 'list', tab: 'up', id: null }, // list | detail
    loading: true,
    query: '',
    cat: 'all',         // 分类筛选（'all' 或 CAT 键）
    chg: 'all',         // 涨跌分类筛选（'all' 或 up2/up1/flat/down1/down2/none）
    favSort: 'time',    // 收藏页排序：time/price/chg
    alch: { mode: '10', crate: null, tier: 'mil', st: false, fee: true, slots: [] },
    chart: null,
    range: 30,
    history: [],        // 浏览历史栈（用于返回）
    navigatingBack: false
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = $('#app');
  const searchInput = $('#searchInput');
  const searchWrap = $('#searchWrap');
  const searchSuggest = $('#searchSuggest');

  const fmt = n => '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtSign = n => (n > 0 ? '+' : '') + n.toFixed(2);
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 收藏系统（localStorage 持久化；按 market_hash_name 存储，数据刷新不丢收藏） ----------
  const FAV_KEY = 'csskin-favs';
  let FAVS = (() => { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || {}; } catch (e) { return {}; } })();
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(FAVS)); } catch (e) {}
    // exe 场景：落盘 exe 同目录 favorites.json（localStorage 在 WebView2 的 file:// 下不可靠）
    if (window.pywebview && window.pywebview.api && window.pywebview.api.save_favorites) {
      window.pywebview.api.save_favorites(JSON.stringify(FAVS));
    }
  }
  // 桥就绪后用 favorites.json（权威）恢复收藏
  function initFavsFromBridge() {
    try {
      if (!(window.pywebview && window.pywebview.api && window.pywebview.api.load_favorites)) return;
      window.pywebview.api.load_favorites().then(s => {
        try {
          const f = s ? JSON.parse(s) : null;
          if (f && typeof f === 'object' && Object.keys(f).length) {
            FAVS = f;
            try { localStorage.setItem(FAV_KEY, JSON.stringify(FAVS)); } catch (e) {}
            render();   // 恢复后刷新星标状态
          }
        } catch (e) {}
      }).catch(() => {});
    } catch (e) {}
  }
  if (window.pywebview && window.pywebview.api && window.pywebview.api.load_favorites) initFavsFromBridge();
  else window.addEventListener('pywebviewready', initFavsFromBridge);
  const isFav = name => !!FAVS[name];
  function toggleFav(name) {
    if (FAVS[name]) delete FAVS[name]; else FAVS[name] = Date.now();
    saveFavs();
    return isFav(name);
  }
  const favCount = () => Object.keys(FAVS).length;

  // 从名称中拆出磨损
  function wearOf(name) {
    const m = name.match(/\((.+)\)$/);
    return m ? m[1] : '';
  }
  // 从名称中拆出武器名 / 涂装名
  function splitName(name) {
    const noWear = name.replace(/\s*\(.+\)$/, '');
    const idx = noWear.indexOf('|');
    if (idx < 0) return { weapon: noWear, paint: '' };
    return { weapon: noWear.slice(0, idx).trim(), paint: noWear.slice(idx + 1).trim() };
  }

  // ---------- 磨损 / 家族工具（配合 data.js 的 WEARDB：{cat, w:普通, st:StatTrak, sv:纪念}） ----------
  const WEAR_ZH = { fn: '崭新出厂', mw: '略有磨损', ft: '久经沙场', ww: '破损不堪', bs: '战痕累累', van: '原版' };
  const WEAR_EN = { fn: 'Factory New', mw: 'Minimal Wear', ft: 'Field-Tested', ww: 'Well-Worn', bs: 'Battle-Scarred' };
  const WEAR_ORDER = ['fn', 'mw', 'ft', 'ww', 'bs', 'van'];
  const WEAR_SUFFIX_RE = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
  const WEAR_EN_KEY = { 'Factory New': 'fn', 'Minimal Wear': 'mw', 'Field-Tested': 'ft', 'Well-Worn': 'ww', 'Battle-Scarred': 'bs' };
  const CAT_KEYS = ['rifle', 'sniper', 'pistol', 'smg', 'shotgun', 'mg', 'knife', 'glove',
    'sticker', 'graffiti', 'music', 'charm', 'patch', 'agent', 'capsule', 'case', 'misc'];
  const WEAPON_CATS = ['rifle', 'sniper', 'pistol', 'smg', 'shotgun', 'mg', 'knife', 'glove'];
  const COL_LABEL = { w: '普通版', st: 'StatTrak™ 版', sv: '纪念版' };
  // 涨跌分类（7 日口径；与 engine 的 changeClass 键一致）
  const CHG_CLASS = [
    { key: 'up2', name: '大涨', desc: '≥ +10%' },
    { key: 'up1', name: '上涨', desc: '+3 ~ 10%' },
    { key: 'flat', name: '盘整', desc: '±3%' },
    { key: 'down1', name: '下跌', desc: '-3 ~ 10%' },
    { key: 'down2', name: '大跌', desc: '≤ -10%' },
    { key: 'none', name: '无数据', desc: '历史快照积累中' }
  ];
  const CHG_NAME = {};
  CHG_CLASS.forEach(c => CHG_NAME[c.key] = c.name);
  // 名称 → { base 皮肤家族, col 版本列 }（与 crawler.js 的 parseVariant 一致）
  function variantOf(name) {
    if (/^Souvenir /.test(name)) return { base: name.slice(9), col: 'sv' };
    if (/^★ StatTrak™ /.test(name)) return { base: '★ ' + name.slice(12), col: 'st' };
    if (/^StatTrak™ /.test(name)) return { base: name.slice(10), col: 'st' };
    return { base: name, col: 'w' };
  }
  // 皮肤家族键：版本前缀归一 + 去掉磨损后缀（原版刀具/收藏品无后缀自成家族）
  function famKeyOf(name) {
    const v = variantOf(name);
    const m = v.base.match(WEAR_SUFFIX_RE);
    return m ? v.base.slice(0, m.index) : v.base;
  }
  const wearKeyOf = name => {
    const m = variantOf(name).base.match(WEAR_SUFFIX_RE);
    return m ? WEAR_EN_KEY[m[1]] : 'van';
  };
  // 找当前库里某家族某版本某磨损的条目
  const findVariant = (base, wk, col) => ALL_ITEMS.find(i =>
    variantOf(i.name).col === col && famKeyOf(i.name) === base && wearKeyOf(i.name) === wk);

  // ---------- 路由 ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'detail' && parts[1]) return { page: 'detail', tab: state.route.tab, id: +parts[1] };
    if (parts[0] === 'fav') return { page: 'fav', tab: state.route.tab, id: null };
    if (parts[0] === 'alchemy') return { page: 'alchemy', tab: state.route.tab, id: null };
    const tab = parts[0] === 'down' ? 'down' : 'up';
    return { page: 'list', tab, id: null };
  }
  function nav(hash) { location.hash = hash; }
  function goList(tab) { nav(tab === 'down' ? '/down' : '/up'); }
  function goDetail(id) { nav('/detail/' + id); }

  window.addEventListener('hashchange', () => {
    const r = parseHash();
    const tabChanged = r.page !== state.route.page || (r.page === 'list' && r.tab !== state.route.tab);
    const itemChanged = r.page === 'detail' && r.id !== state.route.id;
    // 正常前进时压栈；回退时不压
    if (state.navigatingBack) {
      state.navigatingBack = false;
    } else {
      const cur = state.route;
      const same = cur.page === r.page && cur.tab === r.tab && cur.id === r.id;
      if (!same) state.history.push(cur);
    }
    state.route = r;
    render({ animate: tabChanged || itemChanged });
    updateBackBtn();
  });

  // ---------- 返回（历史栈回退） ----------
  function routeHash(r) {
    if (r.page === 'detail') return '/detail/' + r.id;
    if (r.page === 'fav') return '/fav';
    if (r.page === 'alchemy') return '/alchemy';
    return r.tab === 'down' ? '/down' : '/up';
  }
  function goBack() {
    while (state.history.length) {
      const prev = state.history.pop();
      const same = prev.page === state.route.page && prev.tab === state.route.tab && prev.id === state.route.id;
      if (!same) {
        state.navigatingBack = true;
        nav(routeHash(prev));
        return;
      }
    }
    // 栈空：回榜单
    goList(state.route.tab);
  }
  function updateBackBtn() {
    const btn = $('#topBackBtn');
    const badge = $('#backBadge');
    if (!btn || !badge) return;
    btn.classList.toggle('show', state.history.length > 0);
    if (state.history.length > 1) {
      badge.textContent = state.history.length;
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }
  $('#topBackBtn').addEventListener('click', goBack);

  // Alt + ← 快捷键返回
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'ArrowLeft' || e.code === 'ArrowLeft')) {
      e.preventDefault();
      goBack();
    }
  });

  $('#logoHome').addEventListener('click', () => goList(state.route.tab));
  $('#favBtn').addEventListener('click', () => {
    if (state.route.page === 'fav') goList(state.route.tab);   // 再点一次回榜单
    else nav('/fav');
  });
  $('#alchBtn').addEventListener('click', () => {
    if (state.route.page === 'alchemy') goList(state.route.tab);
    else nav('/alchemy');
  });

  // ---------- 渲染入口 ----------
  function render(opt) {
    const fb = $('#favBtn');
    if (fb) {
      fb.textContent = favCount() ? '★' : '☆';
      fb.classList.toggle('active', state.route.page === 'fav');
    }
    const ab = $('#alchBtn');
    if (ab) ab.classList.toggle('active', state.route.page === 'alchemy');
    if (state.loading) { renderSkeleton(); return; }
    if (state.route.page === 'detail') renderDetail();
    else if (state.route.page === 'fav') renderFavs();
    else if (state.route.page === 'alchemy') renderAlchemy();
    else renderList(opt && opt.animate);
  }

  // ---------- 骨架屏（模拟加载） ----------
  function renderSkeleton() {
    app.innerHTML = `
      <div class="skeleton-screen">
        <div class="sk-line sk-shimmer"></div>
        <div class="sk-line sk-shimmer"></div>
        <div class="sk-line sk-shimmer"></div>
        <div class="sk-line sk-shimmer"></div>
        <div class="sk-line sk-shimmer"></div>
        <div class="sk-line sk-shimmer"></div>
      </div>`;
    const toast = document.createElement('div');
    toast.className = 'loading-toast';
    toast.id = 'loadToast';
    toast.innerHTML = '<span class="spinner"></span> 正在同步市场行情…';
    document.body.appendChild(toast);
    setTimeout(() => {
      state.loading = false;
      $('#loadToast') && $('#loadToast').remove();
      render();
    }, 900);
  }

  // ---------- 榜单页（长列表：分批渲染 + 懒加载） ----------
  const BATCH = 60; // 每批渲染行数

  // 中文搜索别名（饰品市场名为英文，常用中文词 → 英文匹配词）
  const SEARCH_ALIAS = {
    '爪子刀': 'gut knife', '刺刀': 'bayonet', 'm9刺刀': 'm9 bayonet', '折叠刀': 'flip knife',
    '蝴蝶刀': 'butterfly knife', '弯刀': 'falchion knife', '短剑': 'shadow daggers', '熊刀': 'bowie knife',
    '砍刀': 'huntsman knife', '流浪者': 'ursus knife', '腰刀': 'navaja knife', '骨架刀': 'skeleton knife',
    '爪刀': 'talon knife', '经典刀': 'classic knife', '伞刀': 'survival knife', '库克里刀': 'kukri knife',
    '手套': 'gloves', '印花': 'sticker', '布章': 'patch', '探员': 'agent', '音乐盒': 'music kit',
    '涂鸦': 'graffiti', '挂件': 'charm', '武器箱': 'case', '胶囊': 'capsule', '纪念': 'souvenir'
  };

  // ---------- 收藏页 ----------
  function renderFavs() {
    const kw = state.query.trim().toLowerCase();
    const effKw = SEARCH_ALIAS[kw] || kw;
    let items = Object.keys(FAVS).sort((a, b) => FAVS[b] - FAVS[a])
      .map(n => ALL_ITEMS.find(i => i.name === n))
      .filter(Boolean);
    if (effKw) items = items.filter(i => i.name.toLowerCase().includes(effKw));
    if (state.cat !== 'all') items = items.filter(i => i.cat === state.cat);
    const sorters = {
      time: (a, b) => FAVS[b.name] - FAVS[a.name],
      price: (a, b) => b.currentPrice - a.currentPrice,
      chg: (a, b) => b.changePercent - a.changePercent
    };
    items.sort(sorters[state.favSort] || sorters.time);

    const totalValue = items.reduce((s, i) => s + i.currentPrice, 0);
    const chgItems = items.filter(i => !(i.refOnly && !i.historyReal));
    const totalChg = chgItems.reduce((s, i) => s + i.changeAmount, 0);

    const emptyHtml = favCount() === 0
      ? '<div class="no-result"><div class="nr-title">☆ 还没有收藏</div><div class="nr-desc">在榜单、搜索结果或详情页点击 ☆ 图标，即可收藏关注的饰品并在这里跟踪价格与涨跌</div></div>'
      : '<div class="no-result"><div class="nr-title">🔍 没有匹配的收藏</div><div class="nr-desc">换个关键词或分类试试</div></div>';

    app.innerHTML = `
      <div class="back-bar">
        <button class="back-btn" id="favBackBtn">← 返回榜单</button>
        <span style="font-size:12px;color:var(--text-faint)">收藏列表 · 保存在本机，重启不丢</span>
      </div>
      <section class="fav-stats">
        <div class="stat-card"><span class="stat-label">收藏饰品</span><span class="stat-value accent">${items.length}</span></div>
        <div class="stat-card"><span class="stat-label">合计当前价值</span><span class="stat-value">${fmt(totalValue)}</span></div>
        <div class="stat-card"><span class="stat-label">7日合计涨跌</span><span class="stat-value ${totalChg > 0 ? 'up-c' : totalChg < 0 ? 'down-c' : ''}">${totalChg > 0 ? '+' : ''}${fmt(totalChg)}</span></div>
      </section>
      <div class="cat-chips">
        ${[['time', '按收藏时间'], ['price', '按当前价'], ['chg', '按涨跌']].map(([k, n]) => `<button class="chip ${state.favSort === k ? 'active' : ''}" data-sort="${k}">${n}</button>`).join('')}
      </div>
      <div class="cat-chips" id="catChips">
        <button class="chip ${state.cat === 'all' ? 'active' : ''}" data-cat="all">全部 <b>${items.length}</b></button>
        ${CAT_KEYS.filter(k => items.some(i => i.cat === k)).map(k => `
          <button class="chip ${state.cat === k ? 'active' : ''}" data-cat="${k}">${CAT[k].name} <b>${items.filter(i => i.cat === k).length}</b></button>`).join('')}
      </div>
      <div class="item-list list-anim" id="itemList">${items.length ? items.map((i, idx) => rowHTML(i, idx, effKw)).join('') : emptyHtml}</div>`;

    $('#favBackBtn').addEventListener('click', goBack);
    app.querySelectorAll('[data-sort]').forEach(btn => btn.addEventListener('click', () => { state.favSort = btn.dataset.sort; renderFavs(); }));
    app.querySelectorAll('#catChips .chip').forEach(btn => btn.addEventListener('click', () => { state.cat = btn.dataset.cat; renderFavs(); }));
    wireListDelegation();
  }

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
    pool.forEach(p => {
      BANDS.forEach(b => {
        if (Math.max(b[1], p.f[0]) < Math.min(b[2], p.f[1])) {
          const pr = alchPrice(p.n, b[0], st);
          if (pr) variants.push({ n: p.n, cn: p.cn || p.n, band: b[0], float: clampF(WEAR_MID[b[0]], p.f[0], p.f[1]), price: pr.price });
        }
      });
    });
    if (!variants.length) return null;
    const nextKey = NEXT_TIER[tier];
    const outPool = nextKey === 'gold' ? (crate.gold || []) : (crate.t[nextKey] || []);
    if (!outPool.length) return null;
    const evOfAvg = avg => outPool.reduce((s, o) => {
      const f = o.f[0] + avg * (o.f[1] - o.f[0]);
      const gloves = /Gloves|Glove/.test(o.n);
      const pr = alchPrice(o.n, wearBandOf(f), st && !gloves);
      return s + (pr ? pr.price / outPool.length : 0);
    }, 0);
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
    // 平均浮动断点分段（产出磨损跨档处 EV 跳变）
    const bps = new Set([0.002, 0.998]);
    for (const o of outPool) for (const bd of [0.07, 0.15, 0.38, 0.45]) {
      const a = (bd - o.f[0]) / (o.f[1] - o.f[0]);
      if (a > 0 && a < 1) bps.add(a);
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
      const avg = b * STEP / 10, cost = dp[10][b].c, ev = evOfAvg(avg);
      return { avg, cost, ev, net: ev * (fee ? 0.87 : 1) - cost, recipe: mkRecipe(b) };
    };
    let best = null, worst = null, minF = null, maxF = null;
    const segs = [...bps].sort((a, b) => a - b);
    for (let i = 0; i < segs.length - 1; i++) {
      const mid = (segs[i] + segs[i + 1]) / 2;
      const b = clampF(Math.round(mid * 10 / STEP), 0, 200);
      const r = evalB(b);
      if (!r) continue;
      if (!best || r.net > best.net) best = r;
      if (!worst || r.net < worst.net) worst = r;
    }
    for (let b = 0; b < NB; b++) if (dp[10][b]) { if (minF === null) minF = evalB(b); break; }
    for (let b = NB - 1; b >= 0; b--) if (dp[10][b]) { if (maxF === null) maxF = evalB(b); break; }
    return { best, worst, minF, maxF, scanned: variants.length };
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
    const slotPrice = s => s.manual
      ? (s.mprice != null ? { price: s.mprice, refOnly: false } : (alchPrice(s.name, s.wear, A.st)))
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
    const net = ev * (A.fee ? 0.87 : 1) - cost;
    const roi = cost > 0 ? net / cost * 100 : 0;

    // 极值公式扫描（仅 10:1；5:1 组合空间不同）
    let optHtml = '';
    if (!is5) {
      const opt = alchOptimize(crate, tier, A.st, A.fee);
      if (opt) {
        const card = (title, r, cls) => {
          if (!r) return '';
          const recipe = r.recipe.map(x => `${x.count}× ${esc(x.cn)}（${WEAR_ZH[x.band]}）`).join(' + ');
          return `<div class="alch-ext ${cls || ''}">
            <div class="alch-ext-title">${title}</div>
            <div class="alch-ext-num">平均浮动 ${r.avg.toFixed(3)} · 成本 ${fmt(r.cost)} · EV ${fmt(r.ev)} · <b class="${r.net > 0 ? 'up-c' : 'down-c'}">${r.net > 0 ? '+' : ''}${fmt(r.net)}</b></div>
            <div class="alch-ext-recipe">${recipe}</div>
          </div>`;
        };
        optHtml = `
          <section class="chart-card">
            <div class="chart-head"><div class="chart-title"><span class="dot dot-ref"></span>极值公式扫描</div>
              <span class="wear-hint">在该集合该档位下，穷举 10 槽浮动与皮肤组合的最低成本路径 · 扫描 ${opt.scanned} 个（皮肤×磨损）变体</span></div>
            <div class="alch-ext-grid">
              ${card('最赚公式', opt.best, 'alch-ext-best')}
              ${card('最赔公式', opt.worst, 'alch-ext-worst')}
              ${card('产出浮动最小', opt.minF)}
              ${card('产出浮动最大', opt.maxF)}
            </div>
            <div class="wear-hint" style="padding:0 12px 10px">产出浮动最小/最大 = 可实现的最低/最高平均输入浮动；最赚/最赔 = 该浮动水平下成本最低配方的净收益。成交不足 3 次的产出不参与。</div>
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
          <label class="alch-opt"><input type="checkbox" id="alchFee" ${A.fee ? 'checked' : ''}> 计入 13% Steam 市场费</label>
          <span class="wear-hint">产出浮动 = min + 平均输入浮动 × (max − min) · 磨损档默认档位中值，可手动改 · 每槽 ✎ 可手动输入皮肤与单价</span>
        </div>
        <div class="alch-slots" id="alchWrap">${A.slots.map((s, i) => slotHtml(s, i)).join('')}</div>
        <datalist id="alchDl">${crates.flatMap(c => [...Object.values(c.t).flat(), ...(c.gold || [])]).map(e => `<option value="${esc(e.n)}">${esc(e.cn || e.n)}</option>`).join('')}</datalist>
      </section>
      <section class="alch-summary">
        <div class="stat-card"><span class="stat-label">输入成本（${nSlots} 件${costUnknown ? ` · ${costUnknown} 件无价` : ''}）</span><span class="stat-value">${fmt(cost)}</span></div>
        <div class="stat-card"><span class="stat-label">平均输入浮动</span><span class="stat-value">${avgF.toFixed(4)}</span></div>
        <div class="stat-card"><span class="stat-label">期望产出 EV</span><span class="stat-value">${fmt(ev)}</span></div>
        <div class="stat-card"><span class="stat-label">净收益 ${A.fee ? '（含 13% 费）' : ''}</span><span class="stat-value ${net > 0 ? 'up-c' : 'down-c'}">${net > 0 ? '+' : ''}${fmt(net)}（${roi.toFixed(1)}%）</span></div>
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
    $('#alchFee').addEventListener('change', e => { A.fee = e.target.checked; renderAlchemy(); });
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

  function renderList(animate) {
    const tab = state.route.tab;
    const kw = state.query.trim().toLowerCase();
    const searching = !!kw;
    // 搜索：全库统一结果（该武器/皮肤的所有磨损与版本，按当前价排序，行内显示实时涨幅）
    // 无搜索：涨价榜/降价榜（热门池，各取涨幅居前的前 100 量级）
    const effKw = SEARCH_ALIAS[kw] || kw;
    const base = searching
      ? ALL_ITEMS.filter(i => i.name.toLowerCase().includes(effKw)).sort((a, b) => b.currentPrice - a.currentPrice)
      : (tab === 'up' ? RISING : FALLING);
    const catFiltered = state.cat === 'all' ? base : base.filter(i => i.cat === state.cat);
    const filtered = state.chg === 'all' ? catFiltered : catFiltered.filter(i => i.changeClass === state.chg);
    const catCounts = {};
    base.forEach(i => { catCounts[i.cat] = (catCounts[i.cat] || 0) + 1; });
    const chgCounts = {};
    catFiltered.forEach(i => { chgCounts[i.changeClass] = (chgCounts[i.changeClass] || 0) + 1; });

    // 市场概览：中位数（均价会被天价刀拉偏）
    const sortedPrices = ALL_ITEMS.map(i => i.currentPrice).sort((a, b) => a - b);
    const median = sortedPrices.length
      ? (sortedPrices[(sortedPrices.length - 1) >> 1] + sortedPrices[sortedPrices.length >> 1]) / 2
      : 0;

    state.listItems = filtered;
    state.listShown = Math.min(BATCH, filtered.length);
    const hasMore = state.listShown < filtered.length;

    const listHTML = filtered.length
      ? filtered.slice(0, state.listShown).map((item, idx) => rowHTML(item, idx, kw)).join('')
        + (hasMore ? '<div id="listSentinel" class="list-sentinel">↓ 滚动加载更多</div>' : '')
      : noResultHTML();

    app.innerHTML = `
      <section class="market-overview">
        <div class="stat-card"><span class="stat-label">监测饰品</span><span class="stat-value accent">${ALL_ITEMS.length}</span></div>
        <div class="stat-card"><span class="stat-label">上涨饰品</span><span class="stat-value up">${RISING.length}</span></div>
        <div class="stat-card"><span class="stat-label">下跌饰品</span><span class="stat-value down">${FALLING.length}</span></div>
        <div class="stat-card"><span class="stat-label">在售中位价</span><span class="stat-value">${fmt(median)}</span></div>
      </section>
      <div class="tabs">
        <button class="tab-btn ${tab === 'up' ? 'active' : ''}" data-tab="up">
          <span class="tab-arrow">▲</span> 涨价榜 <span class="tab-count">${RISING.length}</span>
        </button>
        <button class="tab-btn ${tab === 'down' ? 'active' : ''}" data-tab="down">
          <span class="tab-arrow">▼</span> 降价榜 <span class="tab-count">${FALLING.length}</span>
        </button>
      </div>
      <div class="cat-chips" id="catChips">
        <button class="chip ${state.cat === 'all' ? 'active' : ''}" data-cat="all">全部 <b>${base.length}</b></button>
        ${CAT_KEYS.filter(k => catCounts[k]).map(k => `
          <button class="chip ${state.cat === k ? 'active' : ''}" data-cat="${k}">${CAT[k].name} <b>${catCounts[k]}</b></button>`).join('')}
      </div>
      <div class="cat-chips chg-chips" id="chgChips">
        <button class="chip ${state.chg === 'all' ? 'active' : ''}" data-chg="all">全部涨跌 <b>${catFiltered.length}</b></button>
        ${CHG_CLASS.filter(c => chgCounts[c.key]).map(c => `
          <button class="chip chg-${c.key} ${state.chg === c.key ? 'active' : ''}" data-chg="${c.key}" title="7日涨跌 ${c.desc}">${c.name} <b>${chgCounts[c.key]}</b></button>`).join('')}
      </div>
      <div class="rank-meta">
        <span class="hint">${searching
          ? '搜索结果 · 全库 ' + ALL_ITEMS.length + ' 件 · 该系列所有磨损/版本按当前价排序，涨幅为较 7 日前'
          : (tab === 'up' ? '按 7 日涨幅从高到低排序 · 覆盖 Steam 采集条目，第三方条目历史积累后自动入榜' : '按 7 日跌幅从高到低排序 · 覆盖 Steam 采集条目，第三方条目历史积累后自动入榜')}</span>
        <span class="hint">共 ${filtered.length} 件${searching ? ' · 关键词「' + esc(state.query.trim()) + '」' : ''}${state.cat !== 'all' ? ' · 分类「' + CAT[state.cat].name + '」' : ''}</span>
      </div>
      <div class="item-list list-anim" id="itemList">${listHTML}</div>`;

    // 分类筛选
    app.querySelectorAll('#catChips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.cat = btn.dataset.cat;
        renderList(false);
      });
    });

    // 涨跌分类筛选
    app.querySelectorAll('#chgChips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.chg = btn.dataset.chg;
        renderList(false);
      });
    });

    // 标签切换（带离场动画）；搜索态下点标签 = 清空搜索回到榜单
    app.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const go = () => {
          if (state.query) {
            searchInput.value = ''; state.query = ''; searchWrap.classList.remove('has-value');
          }
          goList(btn.dataset.tab);
        };
        if (btn.dataset.tab === tab && !state.query) return;
        const list = $('#itemList');
        if (list) { list.classList.add('leaving'); setTimeout(go, 180); }
        else go();
      });
    });

    // 事件委托：星标收藏 / 行点击 / 无结果入口点击（榜单、搜索、收藏页共用）
    wireListDelegation();

    // 滚动到底自动追加下一批
    setupSentinel();

    // 搜索命中：滚动到第一条命中项并高亮
    if (kw && filtered.length) {
      const first = app.querySelector('.item-row.row-match');
      if (first) {
        setTimeout(() => first.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
      }
    }
  }

  function appendRows() {
    const filtered = state.listItems;
    if (!filtered || state.listShown >= filtered.length) return;
    const kw = state.query.trim().toLowerCase();
    const next = Math.min(state.listShown + BATCH, filtered.length);
    const html = filtered
      .slice(state.listShown, next)
      .map((item, idx) => rowHTML(item, state.listShown + idx, kw))
      .join('');
    state.listShown = next;
    const sentinel = $('#listSentinel');
    if (sentinel) {
      sentinel.insertAdjacentHTML('beforebegin', html);
      if (state.listShown >= filtered.length) sentinel.remove();
    }
  }

  function setupSentinel() {
    const sentinel = $('#listSentinel');
    if (!sentinel || !('IntersectionObserver' in window)) { appendRows(); return; }
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) appendRows();
      if (state.listShown >= state.listItems.length) io.disconnect();
    }, { rootMargin: '500px' });
    io.observe(sentinel);
  }

  function rowHTML(item, idx, kw) {
    const up = item.changePercent > 0;
    const noChg = item.refOnly && !item.historyReal;   // 第三方参考条目：历史快照不足时不显示涨跌
    const matched = kw && item.name.toLowerCase().includes(kw);
    const badge = idx < 3 ? `top${idx + 1}` : '';
    const nameHtml = kw ? highlight(item.name, kw) : esc(item.name);
    return `
      <div class="item-row ${up ? 'row-up' : 'row-down'} ${matched ? 'row-match' : ''}" data-id="${item.id}">
        <div class="rank-badge ${badge}">${idx + 1}</div>
        <img class="item-img" src="${item.image}" alt="${esc(item.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="__imgFallback(this, ${item.id})">
        <div class="item-info">
          <div class="item-name">${nameHtml}</div>
          <div class="item-tags">
            <span class="tag cat">${item.catName}</span>
            ${item.refOnly
              ? '<span class="tag ref-tag">第三方参考价</span>'
              : `<span class="tag rarity" style="--rc:${item.rarityColor}">${item.rarityName}</span>`}
            <span class="tag wear">${wearOf(item.name) || '无磨损'}</span>
          </div>
        </div>
        <div class="item-nums">
          <div class="price-block">
            <div class="price-now">${fmt(item.currentPrice)}</div>
            <div class="price-prev">${noChg ? '第三方参考' : `7日前 ${fmt(item.previousPrice)}`}</div>
          </div>
          <div class="change-block">
            ${noChg
              ? '<div class="change-percent" style="background:rgba(255,255,255,0.05);color:var(--text-faint)">快照积累中</div>'
              : `<div class="change-amount ${up ? 'up-c' : 'down-c'}">${fmtSign(item.changeAmount).replace('+', '+¥').replace('-', '-¥')}</div>
            <div class="change-percent ${up ? 'up-c up-bg' : 'down-c down-bg'}">
              <span class="arrow">${up ? '▲' : '▼'}</span>${up ? '+' : ''}${item.changePercent.toFixed(2)}%
            </div>`}
          </div>
          <button class="fav-btn ${isFav(item.name) ? 'on' : ''}" data-name="${esc(item.name)}" title="${isFav(item.name) ? '取消收藏' : '收藏'}">${isFav(item.name) ? '★' : '☆'}</button>
        </div>
      </div>`;
  }

  function highlight(name, kw) {
    const i = name.toLowerCase().indexOf(kw);
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark style="background:rgba(102,192,244,0.35);color:#fff;border-radius:3px;padding:0 2px;">' + esc(name.slice(i, i + kw.length)) + '</mark>' + esc(name.slice(i + kw.length));
  }

  // 榜单/搜索无结果
  function noResultHTML() {
    const kw = state.query.trim();
    return `
      <div class="no-result">
        <div class="nr-title">🔍 没有找到匹配的饰品</div>
        <div class="nr-desc">${kw
          ? '全库 ' + ALL_ITEMS.length + ' 件饰品中没有与「' + esc(kw) + '」匹配的条目，换个关键词试试？'
          : '当前筛选条件下没有饰品'}</div>
      </div>`;
  }

  // ---------- 详情页：各磨损价位表（普通 / StatTrak™ / 纪念 三版本，收藏品不展示） ----------
  function wearTableHTML(item) {
    if (typeof WEARDB === 'undefined' || !WEAPON_CATS.includes(item.cat)) return '';
    const base = famKeyOf(item.name);          // 版本归一 + 去磨损后缀后的家族键
    const curCol = variantOf(item.name).col;
    const fam = WEARDB[base];
    if (!fam) return '';
    const cols = ['w', 'st', 'sv'].filter(c => fam[c] && Object.keys(fam[c]).length);
    const curKey = wearKeyOf(item.name);
    const rows = WEAR_ORDER.filter(k => cols.some(c => fam[c][k] != null));
    if (!rows.length) return '';
    let maxP = 0;
    rows.forEach(k => cols.forEach(c => { if (fam[c][k] != null) maxP = Math.max(maxP, fam[c][k]); }));

    const cell = (c, k) => {
      const p = fam[c][k];
      if (p == null) return '<td class="w-empty">—</td>';
      const isCur = c === curCol && k === curKey;
      const link = findVariant(base, k, c);
      const barW = maxP ? Math.max(4, Math.round(p / maxP * 100)) : 4;
      return `<td class="${isCur ? 'w-cur' : ''} ${link ? 'w-link' : ''}" ${link ? 'data-fam="' + esc(base) + '" data-wear="' + k + '" data-col="' + c + '" title="查看该版本磨损详情"' : ''}>` +
        `<span class="w-price">${fmt(p)}</span>${isCur ? '<i class="w-cur-badge">当前</i>' : ''}` +
        `<span class="w-bar" style="width:${barW}%"></span></td>`;
    };
    // 可切换的其他版本（该版本至少有一个磨损有对应条目）
    const otherCols = cols.filter(c => c !== curCol && rows.some(k => findVariant(base, k, c)));

    return `
      <section class="chart-card wear-card">
        <div class="chart-head">
          <div class="chart-title"><span class="dot"></span>各磨损价位
            <span class="wear-hint">同系列 Steam 实时挂牌 · 点价格可查看该版本详情</span>
          </div>
          ${otherCols.map(c => `<button class="sib-btn" data-col="${c}">查看${COL_LABEL[c]}</button>`).join('')}
        </div>
        <table class="wear-table">
          <thead><tr>
            <th>磨损等级</th>${cols.map(c => `<th>${cols.length > 1 ? COL_LABEL[c] : '市场挂牌'}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${rows.map(k => `
              <tr>
                <td class="w-name">${WEAR_ZH[k]}<span class="w-en">${k === 'van' ? 'Vanilla' : WEAR_EN[k]}</span></td>
                ${cols.map(c => cell(c, k)).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`;
  }

  // ---------- 详情页：第三方市场参考价卡 ----------
  function refCardHTML(item) {
    if (!item.ref) return '';
    const rows = [
      ['Skinport 最低', item.ref.sp],
      ['market.csgo.com', item.ref.mc],
      ['Waxpeer 最低', item.ref.wx]
    ].filter(r => r[1] != null);
    if (!rows.length) return '';
    const steamP = item.refOnly ? 0 : item.currentPrice;   // refOnly 无 Steam 挂牌价，不比差值
    const sameMarket = r => r[1] > 0 ? (r[1] <= steamP ? 'ref-low' : 'ref-high') : '';
    return `
      <section class="chart-card ref-card">
        <div class="chart-head">
          <div class="chart-title"><span class="dot dot-ref"></span>第三方市场参考
            <span class="wear-hint">第三方现货市场最低价（USD→CNY），与 Steam 挂牌价口径不同，仅供跨平台比价</span>
          </div>
        </div>
        <div class="ref-grid">
          ${rows.map(r => {
            const delta = steamP > 0 ? `<span class="ref-delta">${r[1] <= steamP ? '低于 Steam ' : '高于 Steam '}${Math.abs((r[1] / steamP - 1) * 100).toFixed(0)}%</span>` : '';
            return `
            <div class="ref-item">
              <span class="ref-name">${r[0]}</span>
              <span class="ref-price ${sameMarket(r)}">${fmt(r[1])}</span>
              ${delta}
            </div>`;
          }).join('')}
        </div>
      </section>`;
  }

  // ---------- 详情页 ----------
  function renderDetail() {
    const item = ALL_ITEMS.find(i => i.id === state.route.id);
    if (!item) { goList('up'); return; }
    const up = item.changePercent > 0;
    const noChg = item.refOnly && !item.historyReal;
    const his = item.priceHistory;
    const d30 = pctBetween(his, 30);
    const d90 = pctBetween(his, 90);
    const vola = volatility(his);
    const parts = splitName(item.name);

    app.innerHTML = `
      <div class="back-bar">
        <button class="back-btn" id="backBtn">← 返回${state.route.tab === 'up' ? '涨价' : '降价'}榜</button>
        <button class="fav-detail-btn ${isFav(item.name) ? 'on' : ''}" id="favDetailBtn" data-name="${esc(item.name)}">${isFav(item.name) ? '★ 已收藏' : '☆ 收藏'}</button>
        <span style="font-size:12px;color:var(--text-faint)">饰品详情 · 每日均价</span>
      </div>

      <div class="detail-head">
        <img class="detail-img" src="${item.image}" alt="${esc(item.name)}" referrerpolicy="no-referrer" onerror="__imgFallback(this, ${item.id})">
        <div class="detail-title">
          <h2>${esc(parts.weapon)} <span style="color:${item.rarityColor}">| ${esc(parts.paint)}</span></h2>
          <div class="item-tags">
            <span class="tag cat">${item.catName}</span>
            ${item.refOnly
              ? '<span class="tag ref-tag">第三方参考价</span>'
              : `<span class="tag rarity" style="--rc:${item.rarityColor}">${item.rarityName}</span>`}
            <span class="tag wear">${wearOf(item.name) || '原版'}</span>
            ${item.changeClass !== 'none' ? `<span class="tag chg-tag chg-tag-${item.changeClass}">7日${CHG_NAME[item.changeClass]}</span>` : ''}
          </div>
          <div class="detail-quick">
            ${item.refOnly && !item.historyReal
              ? '<span style="color:var(--text-faint)">涨跌数据快照积累中（每日自动刷新）</span>'
              : `7日 <span class="${up ? 'up-c' : 'down-c'}">${up ? '+' : ''}${item.changePercent.toFixed(2)}%</span>
            · 30日 <span class="${d30 > 0 ? 'up-c' : 'down-c'}">${d30 > 0 ? '+' : ''}${d30.toFixed(2)}%</span>
            · 90日 <span class="${d90 > 0 ? 'up-c' : 'down-c'}">${d90 > 0 ? '+' : ''}${d90.toFixed(2)}%</span>`}
          </div>
        </div>
      </div>

      <div class="price-cards">
        <div class="pcard p-low">
          <span class="pc-emoji">📉</span>
          <div class="pc-label">历史最低价</div>
          <div class="pc-value">${fmt(item.lowestPrice)}</div>
          <div class="pc-sub">${his[lowIdx(his)].date} 触及</div>
        </div>
        <div class="pcard p-main">
          <span class="pc-emoji">⚡</span>
          <div class="pc-label">${item.refOnly ? '第三方参考价（Steam 未采集）' : '当前价格'}</div>
          <div class="pc-value">${fmt(item.currentPrice)}</div>
          <div class="pc-sub">${item.refOnly ? '来自第三方现货市场 · 深度爬取后升级为 Steam 挂牌价' : `7日前 ${fmt(item.previousPrice)} · <span class="${up ? 'up-c' : 'down-c'}">${fmtSign(item.changeAmount)}</span>`}</div>
        </div>
        <div class="pcard p-high">
          <span class="pc-emoji">📈</span>
          <div class="pc-label">历史最高价</div>
          <div class="pc-value">${fmt(item.highestPrice)}</div>
          <div class="pc-sub">${his[highIdx(his)].date} 触及</div>
        </div>
      </div>

      ${wearTableHTML(item)}

      <div class="chart-card">
        <div class="chart-head">
          <div class="chart-title"><span class="dot"></span>历史价格走势</div>
          <div class="range-group" id="rangeGroup">
            <button class="range-btn" data-range="7">7天</button>
            <button class="range-btn active" data-range="30">30天</button>
            <button class="range-btn" data-range="90">90天</button>
            <button class="range-btn" data-range="0">全部</button>
          </div>
        </div>
        <div id="chart"></div>
      </div>

      <div class="detail-stats">
        <div class="dstat"><div class="ds-label">7日涨跌幅</div><div class="ds-value ${up ? 'up-c' : 'down-c'}">${noChg ? '—' : (up ? '+' : '') + item.changePercent.toFixed(2) + '%'}</div></div>
        <div class="dstat"><div class="ds-label">30日涨跌幅</div><div class="ds-value ${d30 > 0 ? 'up-c' : 'down-c'}">${noChg ? '—' : (d30 > 0 ? '+' : '') + d30.toFixed(2) + '%'}</div></div>
        <div class="dstat"><div class="ds-label">7日分类</div><div class="ds-value" style="font-size:16px">${item.changeClass !== 'none' ? CHG_NAME[item.changeClass] : '—'}</div></div>
        <div class="dstat"><div class="ds-label">90日波动率</div><div class="ds-value">${noChg ? '—' : vola.toFixed(2) + '%'}</div></div>
      </div>
      ${refCardHTML(item)}`;

    $('#backBtn').addEventListener('click', goBack);
    const favD = $('#favDetailBtn');
    if (favD) favD.addEventListener('click', () => {
      const on = toggleFav(favD.dataset.name);
      favD.classList.toggle('on', on);
      favD.textContent = on ? '★ 已收藏' : '☆ 收藏';
    });

    // 磨损价位表：点击有挂牌详情的价格单元格 -> 跳转该版本该磨损条目
    const wearTable = app.querySelector('.wear-table');
    if (wearTable) {
      wearTable.addEventListener('click', e => {
        const td = e.target.closest('td[data-fam]');
        if (!td) return;
        const it = findVariant(td.dataset.fam, td.dataset.wear, td.dataset.col);
        if (it) goDetail(it.id);
      });
    }
    // 版本切换（普通 / StatTrak™ / 纪念）：优先同磨损，其次该版本任一条目
    app.querySelectorAll('.sib-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const col = btn.dataset.col;
        const it = findVariant(famKeyOf(item.name), wearKeyOf(item.name), col)
          || ALL_ITEMS.find(i => famKeyOf(i.name) === famKeyOf(item.name) && variantOf(i.name).col === col);
        if (it) goDetail(it.id);
      });
    });

    renderChart(item);
  }

  const lowIdx = his => his.reduce((m, p, i) => (p.price < his[m].price ? i : m), 0);
  const highIdx = his => his.reduce((m, p, i) => (p.price > his[m].price ? i : m), 0);
  const pctBetween = (his, days) => {
    const n = Math.min(days, his.length);
    const a = his[his.length - n].price, b = his[his.length - 1].price;
    return (b - a) / a * 100;
  };
  const volatility = his => {
    const rets = his.slice(1).map((p, i) => Math.log(p.price / his[i].price));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    return Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) * Math.sqrt(365) * 100;
  };

  // ---------- ECharts 历史走势 ----------
  function renderChart(item) {
    const el = $('#chart');
    if (!el) return;
    try {
      if (state.chart) { state.chart.dispose(); }
      state.chart = echarts.init(el);
    } catch (e) {
      el.innerHTML = '<div style="color:#ff8a8a;padding:40px;text-align:center;font-family:Consolas,monospace">图表初始化失败：' + (e && e.message || e) + '</div>';
      return;
    }

    const his = item.priceHistory;
    const range = state.range || 30;
    const data = range > 0 ? his.slice(-range) : his;
    const up = item.changePercent > 0;
    const lineColor = up ? '#ff5252' : '#2ecc71';

    const option = {
      backgroundColor: 'transparent',
      grid: { left: 64, right: 28, top: 36, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(18,26,35,0.96)',
        borderColor: '#3a4d63',
        borderWidth: 1,
        textStyle: { color: '#ffffff', fontSize: 12, fontFamily: 'Consolas, monospace' },
        formatter: params => {
          const p = params[0];
          return `${p.name}<br/>价格：<b style="color:${lineColor}">${fmt(p.value)}</b>`;
        }
      },
      xAxis: {
        type: 'category',
        data: data.map(p => p.date),
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#3a4d63' } },
        axisLabel: { color: '#a8b3c2', fontSize: 11 },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitLine: { lineStyle: { color: 'rgba(80,100,125,0.35)', type: 'dashed' } },
        axisLabel: {
          color: '#a8b3c2', fontSize: 11,
          formatter: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v
        }
      },
      series: [{
        name: '价格',
        type: 'line',
        smooth: 0.35,
        symbol: 'circle',
        symbolSize: 7,
        showSymbol: false,
        lineStyle: { color: lineColor, width: 2.6 },
        itemStyle: { color: lineColor, borderColor: '#0e141b', borderWidth: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: up ? 'rgba(255,82,82,0.38)' : 'rgba(46,204,113,0.38)' },
            { offset: 1, color: 'rgba(14,20,27,0)' }
          ])
        },
        data: data.map(p => p.price),
        markPoint: {
          symbolSize: 50,
          label: {
            fontSize: 11,
            color: '#0e141b',
            fontWeight: 700,
            formatter: p => '¥' + (p.value >= 1000 ? (p.value / 1000).toFixed(1) + 'k' : p.value)
          },
          data: [
            { type: 'max', name: '最高', itemStyle: { color: '#ffd700' }, label: { color: '#1a1405' } },
            { type: 'min', name: '最低', itemStyle: { color: '#2ecc71' }, label: { color: '#06210f' } }
          ]
        }
      }],
      dataZoom: [{ type: 'inside', zoomLock: false }]
    };
    state.chart.setOption(option);

    // 时间范围切换
    const group = $('#rangeGroup');
    if (group) {
      group.querySelectorAll('.range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          group.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          state.range = +btn.dataset.range;
          renderChart(item);
        });
      });
    }
    window.addEventListener('resize', () => state.chart && state.chart.resize());
  }

  // ---------- 搜索（防抖 300ms + 下拉建议） ----------
  let debounceTimer = null;
  searchInput.addEventListener('input', () => {
    const v = searchInput.value;
    searchWrap.classList.toggle('has-value', !!v);
    clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.query = v;
        renderSuggest(v.trim());
        if (state.route.page === 'fav') renderFavs();
        else if (state.route.page === 'list') renderList(false);
      }, 300);
  });

  searchInput.addEventListener('focus', () => renderSuggest(searchInput.value.trim()));
  document.addEventListener('click', e => {
    if (!searchWrap.contains(e.target)) searchSuggest.classList.remove('show');
  });

  $('#searchClear').addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    searchWrap.classList.remove('has-value');
    searchSuggest.classList.remove('show');
    if (state.route.page === 'fav') renderFavs();
    else if (state.route.page === 'list') renderList(false);
    searchInput.focus();
  });

  function renderSuggest(q) {
    if (!q) { searchSuggest.classList.remove('show'); return; }
    const kw = q.toLowerCase();
    const hits = ALL_ITEMS.filter(i => i.name.toLowerCase().includes(kw)).slice(0, 6);
    if (!hits.length) {
      searchSuggest.innerHTML = '<div class="suggest-empty">未找到相关饰品</div>';
    } else {
      searchSuggest.innerHTML = hits.map(i => `
        <div class="suggest-item" data-id="${i.id}">
          <img src="${i.image}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="__imgFallback(this, ${i.id})">
          <span class="s-name">${highlight(i.name, kw)}</span>
          <span class="s-price ${i.changePercent > 0 ? 'up-c' : 'down-c'}">${fmt(i.currentPrice)}</span>
        </div>`).join('');
    }
    searchSuggest.classList.add('show');
    searchSuggest.querySelectorAll('.suggest-item').forEach(el => {
      el.addEventListener('click', () => {
        searchSuggest.classList.remove('show');
        searchInput.value = '';
        state.query = '';
        searchWrap.classList.remove('has-value');
        goDetail(+el.dataset.id);
      });
    });
  }

  // 回车：跳到第一个建议项
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = searchSuggest.querySelector('.suggest-item');
      if (first) first.click();
      else if (state.route.page === 'list') {
        // 无建议：渲染无结果提示
        renderList(false);
        searchSuggest.classList.remove('show');
      }
    }
  });

  // ---------- 启动 ----------
  state.route = parseHash();
  // ?now=1 跳过骨架屏（用于自动化截图/E2E）
  if (location.search.includes('now=1')) state.loading = false;
  render();
})();

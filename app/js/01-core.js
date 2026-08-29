/* =====================================================================
 * 应用核心：全局状态 / 格式化工具 / 收藏存储（含 pywebview 桥）/ 数据刷新（限流提示） / 磨损与家族工具 / 涨跌分类
 * ===================================================================== */
'use strict';

  // ---------- 全局状态 ----------
  const state = {
    route: { page: 'list', tab: 'up', id: null }, // list | detail
    loading: true,
    query: '',
    cat: 'all',         // 分类筛选（'all' 或 CAT 键）
    chg: 'all',         // 涨跌分类筛选（'all' 或 up2/up1/flat/down1/down2/none）
    favSort: 'time',    // 收藏页排序：time/price/chg
    alch: { mode: '10', crate: null, tier: 'mil', st: false, feeOn: true, feePct: 15, slots: [] },
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

  // ---------- 数据刷新（桌面版：JS 桥触发爬虫；30 分钟冷却 / 启动落后 2h 自动刷新，Python 侧强制） ----------
  let refreshPoll = null;
  const fmtAge = s => s < 0 ? '未知' : s < 60 ? '刚刚' : s < 3600 ? Math.floor(s / 60) + ' 分钟前' : s < 86400 ? Math.floor(s / 3600) + ' 小时前' : Math.floor(s / 86400) + ' 天前';
  function updateDataAge(sec) {
    const el = $('#dataAge');
    if (el) el.textContent = sec < 0 ? '' : `数据更新于 ${fmtAge(sec)}`;
  }
  function showRefreshToast(html) {
    let t = $('#refreshToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'refreshToast';
      t.className = 'loading-toast';
      document.body.appendChild(t);
    }
    t.innerHTML = `<span class="spinner"></span> ${html}`;
    const rb = $('#refreshBtn');
    if (rb) rb.classList.add('spinning');
  }
  function hideRefreshToast() {
    const t = $('#refreshToast');
    if (t) t.remove();
    const rb = $('#refreshBtn');
    if (rb) rb.classList.remove('spinning');
  }
  function flashToast(text, ms) {
    const t = document.createElement('div');
    t.className = 'loading-toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 5000);
  }
  function pollRefresh() {
    if (refreshPoll) clearInterval(refreshPoll);
    refreshPoll = setInterval(async () => {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.refresh_status) return;
      let st;
      try { st = JSON.parse(await api.refresh_status()); } catch (e) { return; }
      updateDataAge(st.dataAgeSec);
      if (!st.running) {
        clearInterval(refreshPoll); refreshPoll = null;
        hideRefreshToast();
        if (st.error) flashToast('刷新失败：' + st.error.slice(-80), 6000);
        else {
          flashToast('行情已更新，正在载入新数据…', 1500);
          setTimeout(() => { location.href = location.pathname + '?t=' + Date.now() + (location.hash || '#/up'); }, 1000);
        }
      }
    }, 4000);
  }
  async function manualRefresh() {
    const api = window.pywebview && window.pywebview.api;
    if (!api || !api.start_refresh) { flashToast('网页预览模式不支持应用内刷新', 4000); return; }
    let st;
    try { st = JSON.parse(await api.start_refresh()); } catch (e) { return; }
    if (!st.ok) {
      flashToast(st.reason === 'cooldown'
        ? `刷新冷却中：数据 ${fmtAge(st.left)}前已更新，${Math.ceil(st.left / 60)} 分钟后可再次手动刷新（合规限流）`
        : st.reason === 'running' ? '刷新已在进行中…'
        : st.reason === 'node_missing' ? '未检测到 Node.js，无法在应用内刷新'
        : '暂时无法刷新', 5000);
      return;
    }
    showRefreshToast('正在刷新最新行情…（Steam 热门池，约 2 分钟 · 已限流）');
    pollRefresh();
  }
  async function startupDataCheck() {
    const api = window.pywebview && window.pywebview.api;
    const rb = $('#refreshBtn');
    if (rb) rb.addEventListener('click', manualRefresh);
    if (!api || !api.refresh_status) { if (rb) rb.title = '网页预览模式不支持刷新'; return; }
    let st;
    try { st = JSON.parse(await api.refresh_status()); } catch (e) { return; }
    updateDataAge(st.dataAgeSec);
    if (st.running) { showRefreshToast('正在刷新最新行情…'); pollRefresh(); return; }
    if (st.dataAgeSec >= st.autoStaleSec) {
      let r;
      try { r = JSON.parse(await api.start_refresh()); } catch (e) { return; }
      if (r.ok) {
        showRefreshToast(`数据上次更新于 ${fmtAge(st.dataAgeSec)}，正在自动刷新最新行情…（约 2 分钟，已限流）`);
        pollRefresh();
      }
    }
  }
  if (window.pywebview && window.pywebview.api && window.pywebview.api.refresh_status) startupDataCheck();
  else window.addEventListener('pywebviewready', startupDataCheck);
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
  // 磨损中文名（英文磨损名 → 中文；无匹配时回退原文）
  function wearCnOf(name) {
    const en = wearOf(name);
    return WEAR_EN_KEY[en] ? WEAR_ZH[WEAR_EN_KEY[en]] : (en || '');
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

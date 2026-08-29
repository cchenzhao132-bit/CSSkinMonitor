/* =====================================================================
 * hash 路由 / 历史栈返回 / 顶栏按钮事件
 * ===================================================================== */
'use strict';

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

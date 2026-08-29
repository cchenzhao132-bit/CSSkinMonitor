/* =====================================================================
 * 收藏页视图：统计 / 排序 / 筛选
 * ===================================================================== */
'use strict';

  // ---------- 收藏页 ----------
  function renderFavs() {
    const kw = state.query.trim().toLowerCase();
    const effKw = SEARCH_ALIAS[kw] || kw;
    let items = Object.keys(FAVS).sort((a, b) => FAVS[b] - FAVS[a])
      .map(n => ALL_ITEMS.find(i => i.name === n))
      .filter(Boolean);
    if (effKw) items = items.filter(i => i.name.toLowerCase().includes(effKw) || (i.cn || '').toLowerCase().includes(effKw));
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

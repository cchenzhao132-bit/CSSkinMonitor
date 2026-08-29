/* =====================================================================
 * 榜单页视图：长列表分批渲染 / 行渲染 / 懒加载 / 搜索别名与高亮
 * ===================================================================== */
'use strict';

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

  function renderList(animate) {
    const tab = state.route.tab;
    const kw = state.query.trim().toLowerCase();
    const searching = !!kw;
    // 搜索：全库统一结果（该武器/皮肤的所有磨损与版本，按当前价排序，行内显示实时涨幅）
    // 无搜索：涨价榜/降价榜（热门池，各取涨幅居前的前 100 量级）
    const effKw = SEARCH_ALIAS[kw] || kw;
    const base = searching
      ? ALL_ITEMS.filter(i => i.name.toLowerCase().includes(effKw) || (i.cn || '').toLowerCase().includes(effKw)).sort((a, b) => b.currentPrice - a.currentPrice)
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
    const matched = kw && (item.name.toLowerCase().includes(kw) || (item.cn || '').toLowerCase().includes(kw));
    const badge = idx < 3 ? `top${idx + 1}` : '';
    const disp = item.cn || item.name;
    let nameHtml;
    if (kw && disp.toLowerCase().includes(kw)) nameHtml = highlight(disp, kw);
    else if (kw && item.name.toLowerCase().includes(kw)) nameHtml = highlight(item.name, kw);
    else nameHtml = esc(disp);
    return `
      <div class="item-row ${up ? 'row-up' : 'row-down'} ${matched ? 'row-match' : ''}" data-id="${item.id}">
        <div class="rank-badge ${badge}">${idx + 1}</div>
        <img class="item-img" src="${item.image}" alt="${esc(disp)}" loading="lazy" referrerpolicy="no-referrer" onerror="__imgFallback(this, ${item.id})">
        <div class="item-info">
          <div class="item-name" title="${esc(item.name)}">${nameHtml}</div>
          <div class="item-tags">
            <span class="tag cat">${item.catName}</span>
            ${item.refOnly
              ? '<span class="tag ref-tag">第三方参考价</span>'
              : `<span class="tag rarity" style="--rc:${item.rarityColor}">${item.rarityName}</span>`}
            <span class="tag wear">${wearCnOf(item.name) || '无磨损'}</span>
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

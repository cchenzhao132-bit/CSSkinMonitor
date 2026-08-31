/* =====================================================================
 * 详情页视图：三价格卡 / 磨损价位表 / 第三方参考卡 / ECharts 走势
 * ===================================================================== */
'use strict';

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
  const sameMarket = r => steamP > 0 ? (r[1] <= steamP ? 'ref-low' : 'ref-high') : '';
    return `
      <section class="chart-card ref-card">
        <div class="chart-head">
          <div class="chart-title"><span class="dot dot-ref"></span>第三方市场参考
            <span class="wear-hint">第三方现货市场最低价（USD→CNY 固定参考汇率 7.25 换算，非实时）· 与 Steam 挂牌价口径不同，仅供跨平台比价</span>
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
    const noChg = item.refOnly && !item.historyReal;   // 第三方参考条目：历史快照不足时不显示涨跌
    const noData7 = !item.chgAvail;                    // v7.0：无 7 日锚点（短历史/仅剩 15/45 日锚点）→ 数据不足
    const his = item.priceHistory || [];
    const d30 = pctBetween(his, 30);
    const d90 = pctBetween(his, 90);
    const vola = volatility(his);
    const lo = lowIdx(his), hi = highIdx(his);
    const fmtPct = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    const fmtDate = v => v == null ? '暂无' : v.date;
    const parts = splitName(item.name);

    const backLabel = { up: '涨价', down: '降价', flat: '无变动' }[state.route.tab] || '涨价';
    app.innerHTML = `
      <div class="back-bar">
        <button class="back-btn" id="backBtn">← 返回${backLabel}榜</button>
        <button class="fav-detail-btn ${isFav(item.name) ? 'on' : ''}" id="favDetailBtn" data-name="${esc(item.name)}">${isFav(item.name) ? '★ 已收藏' : '☆ 收藏'}</button>
        <span style="font-size:12px;color:var(--text-faint)">饰品详情 · 每日均价</span>
      </div>

      <div class="detail-head">
        <img class="detail-img" src="${item.image}" alt="${esc(item.name)}" referrerpolicy="no-referrer" onerror="__imgFallback(this, ${item.id})">
        <div class="detail-title">
          <h2>${esc(item.cn || item.name)}</h2>
          ${item.cn && item.cn !== item.name ? `<div class="detail-title-en">${esc(item.name)}</div>` : ''}
          <div class="item-tags">
            <span class="tag cat">${item.catName}</span>
            ${item.refOnly
              ? '<span class="tag ref-tag">第三方参考价</span>'
              : `<span class="tag rarity" style="--rc:${item.rarityColor}">${item.rarityName}</span>`}
            <span class="tag wear">${wearCnOf(item.name) || '原版'}</span>
            ${item.changeClass !== 'none' ? `<span class="tag chg-tag chg-tag-${item.changeClass}">7日${CHG_NAME[item.changeClass]}</span>` : ''}
          </div>
          <div class="detail-quick">
            ${noChg || noData7
              ? '<span style="color:var(--text-faint)">7日涨跌：数据不足（7 日锚点未积累到）</span>'
              : `7日 <span class="${up ? 'up-c' : 'down-c'}">${up ? '+' : ''}${item.changePercent.toFixed(2)}%</span>
            · 30日 <span class="${(d30 || 0) > 0 ? 'up-c' : 'down-c'}">${fmtPct(d30)}</span>
            · 90日 <span class="${(d90 || 0) > 0 ? 'up-c' : 'down-c'}">${fmtPct(d90)}</span>`}
          </div>
        </div>
      </div>

      <div class="price-cards">
        <div class="pcard p-low">
          <span class="pc-emoji">📉</span>
          <div class="pc-label">历史最低价</div>
          <div class="pc-value">${item.lowestPrice != null ? fmt(item.lowestPrice) : '—'}</div>
          <div class="pc-sub">${fmtDate(his[lo])} 触及</div>
        </div>
        <div class="pcard p-main">
          <span class="pc-emoji">⚡</span>
          <div class="pc-label">${item.refOnly ? '第三方参考价（Steam 未采集）' : '当前价格'}</div>
          <div class="pc-value">${item.currentPrice != null ? fmt(item.currentPrice) : '—'}</div>
          <div class="pc-sub">${item.refOnly ? '来自第三方现货市场 · 深度爬取后升级为 Steam 挂牌价' : (noData7 ? '7 日涨跌数据不足' : `7日前 ${fmt(item.previousPrice)} · <span class="${up ? 'up-c' : 'down-c'}">${fmtSign(item.changeAmount)}</span>`)}</div>
        </div>
        <div class="pcard p-high">
          <span class="pc-emoji">📈</span>
          <div class="pc-label">历史最高价</div>
          <div class="pc-value">${item.highestPrice != null ? fmt(item.highestPrice) : '—'}</div>
          <div class="pc-sub">${fmtDate(his[hi])} 触及</div>
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
        <div class="dstat"><div class="ds-label">7日涨跌幅</div><div class="ds-value ${up ? 'up-c' : 'down-c'}">${noChg || noData7 ? '—' : (up ? '+' : '') + item.changePercent.toFixed(2) + '%'}</div></div>
        <div class="dstat"><div class="ds-label">30日涨跌幅</div><div class="ds-value ${(d30 || 0) > 0 ? 'up-c' : 'down-c'}">${noChg ? '—' : fmtPct(d30)}</div></div>
        <div class="dstat"><div class="ds-label">7日分类</div><div class="ds-value" style="font-size:16px">${item.changeClass !== 'none' ? CHG_NAME[item.changeClass] : '—'}</div></div>
        <div class="dstat"><div class="ds-label">90日波动率</div><div class="ds-value">${noChg ? '—' : vola == null ? '—' : vola.toFixed(2) + '%'}</div></div>
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

  // ---------- 历史数据边界防护（v7.0：空/单点/非法价格不得产生 NaN 或崩溃） ----------
  // 空或单点历史：lowIdx/highIdx 返回 null，pctBetween/volatility 返回 null，UI 显示「— / 数据不足」
  const lowIdx = his => (his && his.length) ? his.reduce((m, p, i) => (p.price < his[m].price ? i : m), 0) : null;
  const highIdx = his => (his && his.length) ? his.reduce((m, p, i) => (p.price > his[m].price ? i : m), 0) : null;
  const pctBetween = (his, days) => {
    if (!his || his.length < 2) return null;
    const n = Math.min(days, his.length);
    const a = his[his.length - n].price, b = his[his.length - 1].price;
    if (!isFinite(a) || !isFinite(b) || a <= 0) return null;
    return (b - a) / a * 100;
  };
  const volatility = his => {
    if (!his || his.length < 2) return null;
    const rets = his.slice(1).map((p, i) => {
      const r = Math.log(p.price / his[i].price);
      return isFinite(r) ? r : null;
    }).filter(v => v != null);
    if (!rets.length) return null;
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const v = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) * Math.sqrt(365) * 100;
    return isFinite(v) ? v : null;
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
    // resize 只绑定一次（此前每次 renderChart 都新增一个监听器，长会话无限累积）
    if (!renderChart._resizeBound) {
      renderChart._resizeBound = true;
      window.addEventListener('resize', () => state.chart && state.chart.resize());
    }
  }

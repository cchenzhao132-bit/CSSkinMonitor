/* =====================================================================
 * 渲染入口 / 骨架屏 / 启动
 * ===================================================================== */
'use strict';

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

  // ---------- 启动 ----------
  state.route = parseHash();
  // ?now=1 跳过骨架屏（用于自动化截图/E2E）
  if (location.search.includes('now=1')) state.loading = false;
  render();

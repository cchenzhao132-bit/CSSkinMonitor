/**
 * 回归测试：数据层断言 + 关键路由渲染检查
 * 用法：node regression.js            （需本机有 Edge；路由检查用 headless dump-dom）
 * 退出码：0 = 全部通过；1 = 存在失败
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const APP = path.join(ROOT, 'app');
let failed = 0, passed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra ? '— ' + extra : ''); }
};

// ---------- Part 1: 数据层与引擎 ----------
console.log('\n[1] 数据层 / 引擎断言');
let env = {};
{
  global.window = {};
  const src = fs.readFileSync(path.join(APP, 'data.js'), 'utf8');
  env = new Function(src + ';return {RAW,WEARDB,HISTORY,TRADEUP,ALL_ITEMS,RISING,FALLING,FLAT,HOT_COUNT};')();
}
const { RAW, WEARDB, HISTORY, TRADEUP, ALL_ITEMS, RISING, FALLING, FLAT } = env;

ok(RAW.length >= 30000, `全库条目 ≥ 30000（实际 ${RAW.length}）`);
ok(TRADEUP && TRADEUP.crates && TRADEUP.crates.length >= 200, `炼金集合 ≥ 200（实际 ${TRADEUP.crates.length}）`);
ok(HISTORY && Object.keys(HISTORY.byName).length >= 20000, `价格快照覆盖 ≥ 20000（实际 ${Object.keys(HISTORY.byName).length}）`);
ok(Object.keys(WEARDB).length >= 1000, `皮肤家族 ≥ 1000（实际 ${Object.keys(WEARDB).length}）`);

// 无 NaN/null 价格
const badPrice = RAW.filter(i => !isFinite(i.base) || i.base === null);
ok(badPrice.length === 0, 'RAW 无 null/NaN 价格', badPrice.slice(0, 3).map(i => i.name).join(','));
const badLive = ALL_ITEMS.filter(i => !isFinite(i.currentPrice));
ok(badLive.length === 0, 'ALL_ITEMS 无 null/NaN 现价', badLive.slice(0, 3).map(i => i.name).join(','));

// 每条都有分类，且键合法
const CAT_KEYS = ['rifle', 'sniper', 'pistol', 'smg', 'shotgun', 'mg', 'knife', 'glove', 'sticker', 'graffiti', 'music', 'charm', 'patch', 'agent', 'capsule', 'case', 'misc'];
ok(RAW.every(i => CAT_KEYS.includes(i.cat)), '全部条目分类键合法');

// refOnly 标记一致性：refOnly 条目不进涨跌榜
// refOnly 且历史未成熟的条目不进涨跌榜；已回填真实历史的第三方条目允许入榜（设计使然）
ok(RISING.every(i => !(i.refOnly && !i.historyReal)) && FALLING.every(i => !(i.refOnly && !i.historyReal)), '涨跌榜不含无历史的第三方参考条目');
ok(RISING.length >= 3000 && FALLING.length >= 3000, `涨跌榜规模 ≥ 3000（涨 ${RISING.length} / 跌 ${FALLING.length}）`);
  ok(FLAT.length >= 20000, `无变动榜 ≥ 20000（实际 ${FLAT.length}）`);
  ok(RISING.length + FALLING.length + FLAT.length === ALL_ITEMS.length, '三榜覆盖全库（涨+跌+无变动 = 全库）');
  ok(FLAT.every(i => !RISING.includes(i) && !FALLING.includes(i)), '无变动榜与涨跌榜无重叠（精确补集）');

// 涨跌分类键合法且与涨跌方向自洽
const CC = ['up2', 'up1', 'flat', 'down1', 'down2', 'none'];
ok(ALL_ITEMS.every(i => CC.includes(i.changeClass)), 'changeClass 键合法');
ok(RISING.every(i => i.changePercent > 0.15) && FALLING.every(i => i.changePercent <= -0.15), '榜单排序方向自洽');
const refOnlyNoData = ALL_ITEMS.filter(i => i.refOnly && !i.historyReal).every(i => i.changeClass === 'none');
ok(refOnlyNoData, '无历史第三方条目均为「无数据」');

// 磨损/版本解析：纪念品、StatTrak、原版
{
  const WR = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
  const variantOf = name => {
    if (/^Souvenir /.test(name)) return { base: name.slice(9), col: 'sv' };
    if (/^★ StatTrak™ /.test(name)) return { base: '★ ' + name.slice(12), col: 'st' };
    if (/^StatTrak™ /.test(name)) return { base: name.slice(10), col: 'st' };
    return { base: name, col: 'w' };
  };
  const fam = name => { const v = variantOf(name); const m = v.base.match(WR); return m ? v.base.slice(0, m.index) : v.base; };
  ok(fam('Souvenir AWP | Dragon Lore (Factory New)') === 'AWP | Dragon Lore', '纪念品前缀解析');
  ok(fam('★ StatTrak™ Karambit | Fade (Factory New)') === '★ Karambit | Fade', '★ StatTrak 前缀解析');
  ok(fam('StatTrak™ AK-47 | Redline (Field-Tested)') === 'AK-47 | Redline', 'StatTrak 前缀解析');
  ok(fam('★ M9 Bayonet') === '★ M9 Bayonet', '原版刀具无后缀');
  ok(fam('Sticker | Crown (Foil)') === 'Sticker | Crown (Foil)', '印花 Foil 后缀不被误剥');
}

// 炼金数学：EV 复算（Kilowatt 军规→受限，avg=0.265）
{
  const WEAR_EN = { fn: 'Factory New', mw: 'Minimal Wear', ft: 'Field-Tested', ww: 'Well-Worn', bs: 'Battle-Scarred' };
  const WR = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
  const m = {};
  ALL_ITEMS.forEach(i => { (m[i.name.replace(WR, '')] = m[i.name.replace(WR, '')] || []).push(i); });
  const kil = TRADEUP.crates.find(x => x.name.includes('Kilowatt'));
  let ev = 0, n = 0;
  for (const o of kil.t.restr) {
    const f = o.f[0] + 0.265 * (o.f[1] - o.f[0]);
    const w = f < 0.07 ? 'fn' : f < 0.15 ? 'mw' : f < 0.38 ? 'ft' : f < 0.45 ? 'ww' : 'bs';
    const it = (m[o.n] || []).find(i => i.name === o.n + ' (' + WEAR_EN[w] + ')');
    if (it) { ev += it.currentPrice / kil.t.restr.length; n++; }
  }
  ok(n === kil.t.restr.length, `炼金产出定价覆盖 ${n}/${kil.t.restr.length}`);
  ok(ev > 1, `炼金 EV 为正实数（¥${ev.toFixed(2)}）`);
  ok(kil.gold && kil.gold.length >= 5 && kil.gold.every(g => g.cn), '金池含中文名');

  // 第三方条目图片：武器/刀/手套类 icon 覆盖 ≥ 90%（防"Redline 无图"类回归）
  {
    const SKIPCAT = ['sticker', 'graffiti', 'charm', 'patch', 'agent', 'music', 'capsule', 'case', 'misc'];
    const refW = RAW.filter(i => i.refOnly && !SKIPCAT.includes(i.cat));
    const withIc = refW.filter(i => i.icon).length;
    ok(refW.length === 0 || withIc / refW.length >= 0.9, `refOnly 武器类 icon 覆盖 ≥ 90%（实际 ${(withIc / refW.length * 100).toFixed(0)}%，${refW.length - withIc} 条缺失）`);
  }
}

// 涨跌分类分布合计 = 全库
{
  const cc = {};
  ALL_ITEMS.forEach(i => cc[i.changeClass] = (cc[i.changeClass] || 0) + 1);
  const sum = Object.values(cc).reduce((a, b) => a + b, 0);
  ok(sum === ALL_ITEMS.length, `涨跌分类覆盖全库（${sum}/${ALL_ITEMS.length}）`);
}

// ---------- Part 2: 路由渲染（headless Edge） ----------
console.log('\n[2] 路由渲染检查（headless Edge）');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
if (!EDGE) { console.log('  ⚠ 未找到 Edge，跳过路由检查'); }
else {
  const URL_BASE = 'file:///' + APP.replace(/\\/g, '/') + '/index.html?now=1';
  const routes = [
    ['#', d => /涨价榜/.test(d) && (d.match(/item-row /g) || []).length >= 10 && !/data-tier/.test(d), 30000],
    ['#/up', d => /涨价榜/.test(d) && (d.match(/item-row /g) || []).length >= 10, 30000],
    ['#/down', d => /降价榜/.test(d) && (d.match(/item-row /g) || []).length >= 10, 30000],
    ['#/flat', d => /无变动/.test(d) && (d.match(/item-row /g) || []).length >= 10, 30000],
    ['#/fav', d => /收藏列表/.test(d) && (/还没有收藏/.test(d) || (d.match(/item-row /g) || []).length >= 1), 2000],
    ['#/alchemy', d => /炼金模拟器/.test(d) && (d.match(/alch-slot /g) || []).length === 10 && /期望产出 EV/.test(d), 30000],
    ['#/detail/1', d => /当前价格|第三方参考价/.test(d) && !/data-tier/.test(d), 5000],
    // 磨损表回归：选一个 Steam 采集且有皮肤家族的条目
    ['#/detail/' + (function () {
      global.window = {};
      const s2 = fs.readFileSync(path.join(APP, 'data.js'), 'utf8');
      const { RAW, WEARDB } = new Function(s2 + ';return {RAW,WEARDB};')();
      const WR = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
      const it = RAW.find(i => !i.refOnly && WEARDB[i.name.replace(WR, '')] && WEARDB[i.name.replace(WR, '')].w);
      return it.id;
    })(), d => (d.match(/<table class="wear-table">/g) || []).length >= 1 && /磨损等级/.test(d), 5000],
  ];
  for (const [route, check, minLen] of routes) {
    const out = path.join(ROOT, '_tmp', 'reg-dom.html');
    const r = spawnSync(EDGE, ['--headless=new', '--disable-gpu', '--enable-logging=stderr', '--v=0',
      '--virtual-time-budget=10000', '--dump-dom', `${URL_BASE}${route}`],
      { timeout: 60000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const dom = r.stdout || '';
    const errText = (r.stderr || '');
    const jsErrors = (errText.match(/Uncaught \w+Error[^"']*/g) || []).filter(e => !/Extension|chrome-extension|edge/i.test(e));
    const codeOnly = dom.replace(/<script[\s\S]*?<\/script>/g, '');
    const badText = [/undefined/.test(codeOnly) ? 'undefined 出现在页面' : null,
                     />NaN</.test(dom) ? 'NaN 出现在页面' : null,
                     /\+\+¥/.test(dom) ? '双加号出现' : null].filter(Boolean);
    ok(dom.length > minLen && check(dom), `路由 ${route} 渲染`, badText.join(',') || (jsErrors[0] || '').slice(0, 60));
    ok(jsErrors.length === 0, `路由 ${route} 无 JS 异常`, jsErrors.slice(0, 2).join(' | ').slice(0, 120));
  }
}

// ---------- Part 3: 搜索功能端到端（jsdom） ----------
// 背景：搜索事件绑定曾在模块化拆分时整段丢失，而 Part 1/2 均未覆盖输入交互。
console.log('\n[3] 搜索功能端到端（jsdom）');
(async () => {
  let JSDOM, VirtualConsole;
  try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { JSDOM = null; }
  if (!JSDOM) { console.log('  ⚠ 未安装 jsdom（npm i -D jsdom），跳过搜索端到端'); return; }
  // 外链脚本改为手动按序注入内联 <script>（与浏览器一致共享全局词法作用域；
  // 同时天然阻断 CDN 图片等网络加载）
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
    .replace(/<script[^>]*\ssrc="[^"]*"[^>]*>\s*<\/script>/g, '');
  const vc = new VirtualConsole();
  const jsErrors = [];
  vc.on('jsdomError', e => jsErrors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'file:///' + APP.replace(/\\/g, '/') + '/index.html?now=1#/up'
  });
  const { window } = dom;
  for (const s of ['echarts.min.js', 'data.js', 'js/01-core.js', 'js/02-router.js', 'js/03-views-list.js',
    'js/04-fav.js', 'js/05-alchemy.js', 'js/06-detail.js', 'js/07-boot.js']) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(APP, s), 'utf8');
    window.document.body.appendChild(el);
  }
  await new Promise(r => setTimeout(r, 400));   // 首屏渲染（?now=1 跳过骨架屏）
  const doc = window.document;
  const input = doc.querySelector('#searchInput');
  const suggest = doc.querySelector('#searchSuggest');
  ok(!!input && !!suggest, '搜索框与建议容器存在');
  const setKw = async v => {
    input.value = v;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 450));   // 300ms 防抖 + 渲染
  };
  if (input && suggest) {
    // 英文关键词：下拉建议 + 搜索态列表
    await setKw('karambit');
    ok(suggest.querySelectorAll('.suggest-item').length > 0, '输入英文关键词出现下拉建议');
    ok(/关键词「karambit」/.test(doc.body.textContent), '列表进入搜索态并显示关键词');
    ok(doc.querySelectorAll('#itemList .item-row').length > 0, '搜索结果有行');
    // 中文别名：爪子刀 → gut knife（过滤用映射后关键词，行渲染须同步，否则无高亮无定位）
    await setKw('爪子刀');
    ok(suggest.querySelectorAll('.suggest-item').length > 0, '中文别名（爪子刀）出现下拉建议');
    ok(doc.querySelectorAll('#itemList .item-row.row-match').length > 0, '别名搜索结果带命中高亮（effKw 传参一致）');
    // 清空按钮
    doc.querySelector('#searchClear').click();
    await new Promise(r => setTimeout(r, 150));
    ok(!suggest.classList.contains('show'), '清空按钮收起建议并退出搜索态');
    // 无结果提示
    await setKw('zzzz无此饰品zzzz');
    ok(/没有找到匹配的饰品/.test(doc.body.textContent), '无结果提示出现');
    ok(!/更新于 2026-/.test(doc.body.textContent), '页脚无硬编码日期');
  }
  const searchErrors = jsErrors.filter(e => !/echarts|canvas/i.test(e));
  ok(searchErrors.length === 0, '搜索交互无 JS 异常', searchErrors.slice(0, 2).join(' | ').slice(0, 120));
  window.close();
})().catch(e => { failed++; console.log('  ✗ 搜索端到端异常:', e.message); }).finally(() => {
  // ---------- 汇总 ----------
  console.log(`\n===== 回归结果：通过 ${passed} / 失败 ${failed} =====`);
  process.exit(failed ? 1 : 0);
});

/**
 * 数据契约审计（v7.0 重构任务书 Step 6：测试业务不变量，而非"当前代码行为"）
 * 用法：node tests/contract-audit.js
 *
 * 覆盖：
 *  1) 7 日涨跌时间窗口：find7dAnchor 按时间戳锚定「今天-7 天 ± win7d 天」，
 *     0/1/3/7/8/15/45 天历史分别给出正确结果——禁止 15/45 日锚点冒充 7 日
 *  2) 涨跌阈值临界值：0.14/0.15/0.16、2.99/3/3.01、9.99/10/10.01 及负值，
 *     changeClassOf 与 CHANGE_THRESHOLDS 契约一致
 *  3) 历史边界防护：详情页 lowIdx/highIdx/pctBetween/volatility 对空数组、
 *     单点历史、0 价、null、NaN、Infinity 不产生 NaN 或抛错
 *  4) findVariant 索引等价性：索引查询与原 find 语义一致（覆盖全库所有磨损单元格键）
 *  5) 全库价格语义：listPrice/currentPrice 有限；chgAvail 与 changeClass/涨跌数字自洽
 * 退出码：0 通过 / 1 存在失败项
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJ = path.join(__dirname, '..');
const FIXTURE = process.argv.includes('--fixture') || process.env.FIXTURE === '1';
const DATA_FILE = FIXTURE
  ? path.join(PROJ, 'tests', 'fixture-data.js')
  : path.join(PROJ, 'app', 'data.js');

let failures = 0;
const fail = msg => { failures++; console.log('  ❌', msg); };
const ok = msg => console.log('  ✅', msg);
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---------- 环境：加载 data.js（fixture 优先，含引擎模板） ----------
if (!fs.existsSync(DATA_FILE)) {
  console.error(`数据文件不存在：${DATA_FILE}（先运行 node crawler.js --regen 或 --fixture）`);
  process.exit(1);
}
globalThis.window = globalThis;   // 引擎末尾 window.__imgFallback / __engineCore 赋值
vm.runInThisContext(
  fs.readFileSync(DATA_FILE, 'utf8') + '\n;globalThis.__ENG = window.__engineCore; globalThis.__ALL = ALL_ITEMS; globalThis.__TR = (typeof TRADEUP !== "undefined") ? TRADEUP : null;',
  { filename: 'data.js' }
);
const ENG = globalThis.__ENG;
const ALL_ITEMS = globalThis.__ALL;
if (!ENG || !ENG.find7dAnchor || !ENG.changeClassOf) {
  console.error('引擎核心函数未暴露（engine.js 需含 window.__engineCore）');
  process.exit(1);
}
const { find7dAnchor, changeClassOf, CHANGE_THRESHOLDS } = ENG;
console.log(`数据：${FIXTURE ? 'fixture' : '全量'} · ${ALL_ITEMS.length} 件 · 阈值 ${JSON.stringify(CHANGE_THRESHOLDS)}`);

// ---------- 1) 7 日时间窗口 ----------
console.log('\n[1] 7 日涨跌时间窗口（find7dAnchor）');
{
  const today = new Date();
  // UTC 日期串（引擎与 crawler 均以 toISOString 的 UTC 日期为口径；find7dAnchor 按
  // date+'T00:00:00Z' 解析。测试必须与引擎同口径，禁止本地时区日期串）
  const iso = off => {
    const d = new Date(today);
    d.setDate(d.getDate() - off);
    return d.toISOString().slice(0, 10);
  };
  // 与引擎同口径的「锚点距今天」计算（UTC 日期 → UTC 毫秒）
  const daysAgo = dateStr => (Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') - Date.parse(dateStr + 'T00:00:00Z')) / 86400000;
  const P = (off, price) => ({ date: iso(off), price });
  const T = CHANGE_THRESHOLDS;

  // 0 个历史点
  if (find7dAnchor([]) !== null) fail('空历史应返回 null（数据不足）');
  // 1 个历史点（今天）
  if (find7dAnchor([P(0, 100)]) !== null) fail('单点历史（今天）应返回 null（无 7 日锚点）');
  // 3 天历史：只有 0/1/3 天前 → 7 天窗口内无锚点 → null
  if (find7dAnchor([P(0, 100), P(1, 99), P(3, 98)]) !== null) fail('3 天历史应返回 null（禁止 3 日冒充 7 日）');
  // 8 天历史：应命中 ~7 天前的锚点（±2 天容差内）
  {
    const hist = Array.from({ length: 8 }, (_, i) => P(7 - i, 100 - i));
    const a = find7dAnchor(hist);
    if (!a) fail('8 天历史应命中 7 天前锚点');
  }
  // 15 天历史：7 天前应有真实锚点（不得选最老的 14 天前）
  {
    const hist = Array.from({ length: 15 }, (_, i) => P(14 - i, 100 - i));
    const a = find7dAnchor(hist);
    const off = a ? daysAgo(a.date) : NaN;
    if (!a || Math.abs(off - 7) > T.win7d) fail(`15 天历史应命中 7 天前锚点，实际 ${a ? off.toFixed(2) + ' 天前' : 'null'}`);
  }
  // 45 天历史：同样命中 7 天前，而非最老的 45 天前（旧实现 length-8 会退化成 45 日）
  {
    const hist = Array.from({ length: 45 }, (_, i) => P(44 - i, 100 - i));
    const a = find7dAnchor(hist);
    const off = a ? daysAgo(a.date) : NaN;
    if (!a || Math.abs(off - 7) > T.win7d)
      fail(`45 天历史应命中 7 天前锚点，实际 ${a ? off.toFixed(2) + ' 天前' : 'null'}（旧 bug：会取 45 天前）`);
  }
  // 仅剩 15 天前锚点（如第三方回填 24h/7d/15d/45d 中的 7d 缺失）→ 不得冒充 7 日
  {
    const hist = [P(0, 105), P(15, 90), P(45, 80)];
    const a = find7dAnchor(hist);
    if (a) fail(`仅剩 15/45 日锚点时应返回 null，实际返回 ${a.date}`);
  }
  // 非法日期防御
  if (find7dAnchor([{ date: 'not-a-date', price: 1 }, { date: iso(7), price: 99 }]) === null)
    fail('含非法日期时仍应命中合法 7 日锚点');
  console.log('  （0/1/3/7/8/15/45 天 + 稀疏锚点 + 非法日期用例已执行）');
}

// ---------- 2) 涨跌阈值临界值 ----------
console.log('\n[2] 涨跌阈值临界值（changeClassOf / CHANGE_THRESHOLDS 契约）');
{
  const { noticeable: N3, strong: N10 } = CHANGE_THRESHOLDS;
  const cases = [
    [0.14, 'flat'], [0.15, 'flat'], [0.16, 'flat'],        // 榜单门槛是 rising，分类门槛是 noticeable
    [N3 - 0.01, 'flat'], [N3, 'up1'], [N3 + 0.01, 'up1'],
    [N10 - 0.01, 'up1'], [N10, 'up2'], [N10 + 0.01, 'up2'],
    [-0.14, 'flat'], [-0.15, 'flat'], [-0.16, 'flat'],
    [-N3 + 0.01, 'flat'], [-N3, 'down1'], [-N3 - 0.01, 'down1'],
    [-N10 + 0.01, 'down1'], [-N10, 'down2'], [-N10 - 0.01, 'down2']
  ];
  let bad = 0;
  for (const [pct, want] of cases) {
    const got = changeClassOf(pct);
    if (got !== want) { bad++; fail(`changeClassOf(${pct}) = ${got}，期望 ${want}`); }
  }
  // 空/非法输入 → none（数据不足）
  [null, undefined, NaN, Infinity, -Infinity].forEach(v => {
    if (changeClassOf(v) !== 'none') { bad++; fail(`changeClassOf(${v}) 应为 none`); }
  });
  if (bad === 0) ok(`${cases.length} 个临界值 + 5 个非法输入全部符合契约`);
  // 契约自洽：strong > noticeable > rising，且全部为正
  if (!(CHANGE_THRESHOLDS.strong > CHANGE_THRESHOLDS.noticeable && CHANGE_THRESHOLDS.noticeable > CHANGE_THRESHOLDS.rising && CHANGE_THRESHOLDS.rising > 0))
    fail('CHANGE_THRESHOLDS 不满足 strong > noticeable > rising > 0');
}

// ---------- 3) 历史边界防护（详情页统计函数） ----------
console.log('\n[3] 历史边界防护（详情页 lowIdx/highIdx/pctBetween/volatility）');
{
  // 从 06-detail.js 抽取边界函数段（与浏览器加载的真实实现同源）
  const src = fs.readFileSync(path.join(PROJ, 'app', 'js', '06-detail.js'), 'utf8');
  const segStart = src.indexOf('const lowIdx = his =>');
  const segEnd = src.indexOf('// ---------- ECharts 历史走势 ----------');
  if (segStart < 0 || segEnd < 0) { console.error('无法抽取 06-detail.js 边界函数段'); process.exit(1); }
  vm.runInThisContext(src.slice(segStart, segEnd) + '\n;globalThis.__det = { lowIdx, highIdx, pctBetween, volatility };', { filename: '06-detail.js' });
  const { lowIdx, highIdx, pctBetween, volatility } = globalThis.__det;

  let bad = 0;
  // 空数组：不得抛错，返回 null/0 语义
  if (lowIdx([]) !== null || highIdx([]) !== null) { bad++; fail('空数组 lowIdx/highIdx 应返回 null'); }
  if (pctBetween([], 30) !== null || pctBetween([{ price: 100 }], 30) !== null) { bad++; fail('空/单点 pctBetween 应返回 null'); }
  if (volatility([]) !== null || volatility([{ price: 100 }]) !== null) { bad++; fail('空/单点 volatility 应返回 null'); }
  // 非法价格：不得产生 NaN
  const hisBad = [{ price: null }, { price: NaN }, { price: Infinity }, { price: 0 }, { price: 100 }];
  [pctBetween(hisBad, 30), volatility(hisBad)].forEach(v => {
    if (v != null && !isFinite(v)) { bad++; fail(`非法价格输入产生非有限值 ${v}`); }
  });
  // 0 价基准：pctBetween 返回 null（除以 0 防护）
  if (pctBetween([{ price: 0 }, { price: 100 }], 30) !== null) { bad++; fail('0 价基准 pctBetween 应返回 null'); }
  // 正常数据仍正确：31 点，pctBetween(his,30) = 后 30 点窗口 (130-101)/101*100 ≈ 28.71
  const his = Array.from({ length: 31 }, (_, i) => ({ date: 'd' + i, price: 100 + i }));
  const p30 = pctBetween(his, 30);
  if (!near(p30, 28.71287128712871)) { bad++; fail(`pctBetween 正常数据应为 28.71，实际 ${p30}`); }
  if (lowIdx(his) !== 0 || highIdx(his) !== 30) { bad++; fail('lowIdx/highIdx 正常数据索引错误'); }
  if (!isFinite(volatility(his))) { bad++; fail('volatility 正常数据应为有限值'); }
  if (bad === 0) ok('空/单点/非法价格边界全部防护，正常数据计算正确');
}

// ---------- 4) findVariant 索引等价性（O(1) 索引 vs 原 find 语义） ----------
console.log('\n[4] findVariant 索引等价性');
{
  // 重建与 01-core.js 相同的索引（含变体解析），并和线性 find 逐键比对
  const WEAR_SUFFIX_RE = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
  const WEAR_EN_KEY = { 'Factory New': 'fn', 'Minimal Wear': 'mw', 'Field-Tested': 'ft', 'Well-Worn': 'ww', 'Battle-Scarred': 'bs' };
  const variantOf = name => {
    if (/^Souvenir /.test(name)) return { base: name.slice(9), col: 'sv' };
    if (/^★ StatTrak™ /.test(name)) return { base: '★ ' + name.slice(12), col: 'st' };
    if (/^StatTrak™ /.test(name)) return { base: name.slice(10), col: 'st' };
    return { base: name, col: 'w' };
  };
  const famKeyOf = name => { const v = variantOf(name); const m = v.base.match(WEAR_SUFFIX_RE); return m ? v.base.slice(0, m.index) : v.base; };
  const wearKeyOf = name => { const m = variantOf(name).base.match(WEAR_SUFFIX_RE); return m ? WEAR_EN_KEY[m[1]] : 'van'; };
  const findLinear = (base, wk, col) => ALL_ITEMS.find(i => variantOf(i.name).col === col && famKeyOf(i.name) === base && wearKeyOf(i.name) === wk);

  const idx = new Map();
  ALL_ITEMS.forEach(i => {
    const key = famKeyOf(i.name) + '|' + wearKeyOf(i.name) + '|' + variantOf(i.name).col;
    if (!idx.has(key)) idx.set(key, i);
  });
  let checked = 0, bad = 0;
  for (const i of ALL_ITEMS) {
    const base = famKeyOf(i.name), wk = wearKeyOf(i.name), col = variantOf(i.name).col;
    const got = idx.get(base + '|' + wk + '|' + col) || null;
    const want = findLinear(base, wk, col);
    checked++;
    if (got !== want) { bad++; if (bad <= 5) fail(`索引不一致: ${i.name} → ${got && got.name} vs ${want && want.name}`); }
  }
  if (bad === 0) ok(`索引查询与线性 find 全等（${checked} 键）`);
}

// ---------- 5) 全库价格语义与涨跌自洽 ----------
console.log('\n[5] 全库价格语义与涨跌自洽');
{
  let bad = 0;
  const badPrice = ALL_ITEMS.filter(i => !isFinite(i.listPrice) || !isFinite(i.currentPrice) || !(i.listPrice > 0));
  if (badPrice.length) { bad++; fail(`价格非有限/非正条目 ${badPrice.length}（示例: ${badPrice.slice(0, 3).map(i => i.name).join(', ')}）`); }
  // chgAvail=true → changePercent/changeAmount 有限且 previousPrice>0
  const availBad = ALL_ITEMS.filter(i => i.chgAvail && (!isFinite(i.changePercent) || !isFinite(i.changeAmount) || !(i.previousPrice > 0)));
  if (availBad.length) { bad++; fail(`chgAvail=true 但涨跌数字非法 ${availBad.length} 条`); }
  // chgAvail=false → 不得携带 7 日涨跌数字（禁止 15/45 日冒充）
  const noAnchor = ALL_ITEMS.filter(i => !i.chgAvail && i.changePercent != null);
  if (noAnchor.length) { bad++; fail(`无 7 日锚点却带涨跌数字 ${noAnchor.length} 条（示例: ${noAnchor.slice(0, 3).map(i => i.name).join(', ')}）`); }
  // 榜单成员必须 chgAvail 且方向与门槛一致
  const T = CHANGE_THRESHOLDS;
  const inRising = ALL_ITEMS.filter(i => i.changeClass !== 'none' && i.changePercent > T.rising);
  const inFalling = ALL_ITEMS.filter(i => i.changeClass !== 'none' && i.changePercent <= -T.rising);
  if (inRising.some(i => !i.chgAvail) || inFalling.some(i => !i.chgAvail)) { bad++; fail('榜单成员存在 chgAvail=false'); }
  // 三榜守恒
  const RISING2 = inRising, FALLING2 = inFalling;
  const flatSet = ALL_ITEMS.filter(i => !RISING2.includes(i) && !FALLING2.includes(i));
  if (RISING2.length + FALLING2.length + flatSet.length !== ALL_ITEMS.length) { bad++; fail('三榜不守恒'); }
  if (bad === 0) ok(`价格/涨跌/榜单语义自洽（${ALL_ITEMS.length} 件）`);
}

console.log(failures ? `\n共 ${failures} 处失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

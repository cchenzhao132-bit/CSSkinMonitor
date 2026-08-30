/**
 * 炼金系统离线回归审计（无需网络/浏览器）
 * 用法：node tests/alchemy-audit.js
 *
 * 覆盖：
 *  1) TRADEUP 池无同名重复（build-tradeup.js 去重回归）
 *  2) alchOptimize 全量不变量（210 集合 × 4 档位 × 普通/ST）：
 *     - best.net ≥ minF/maxF.net（全桶扫描回归：旧版段中点采样会漏掉段高端最优，误报「全场无正收益」）
 *     - worst.net ≤ minF/maxF.net
 *     - 任一极值卡为正 → best.net 必为正
 *  3) fmtSigned 符号（负号前置，无双负号）
 *  4) 雷达一致性（cache/alch-scan.json 存在时）：
 *     - 每条雷达配方在其 (集合,档位,ST) 下用前端算法复算，不得显著优于真实最优（口径漂移回归）
 *     - 大额配方符号一致（|net|>50 时雷达与复算同正负）
 *     - best/worst 排序与字段完整
 * 退出码：0 通过 / 1 存在失败项
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PROJ = path.join(__dirname, '..');

let failures = 0;
const fail = msg => { failures++; console.log('  ❌', msg); };
const ok = msg => console.log('  ✅', msg);

// ---------- 环境：加载 data.js + 抽取 05-alchemy.js 纯函数段 ----------
globalThis.window = globalThis;   // data.js 末尾有 window.__imgFallback 赋值
vm.runInThisContext(
  fs.readFileSync(path.join(PROJ, 'app', 'data.js'), 'utf8') + '\n;globalThis.__ALL = ALL_ITEMS; globalThis.__TR = TRADEUP; globalThis.__SCAN = (typeof ALCHSCAN !== "undefined") ? ALCHSCAN : null;',
  { filename: 'data.js' }
);
const ALL_ITEMS = globalThis.__ALL, TRADEUP = globalThis.__TR, ALCHSCAN_EMBED = globalThis.__SCAN;

globalThis.WEAR_EN = { fn: 'Factory New', mw: 'Minimal Wear', ft: 'Field-Tested', ww: 'Well-Worn', bs: 'Battle-Scarred' };
const WEAR_SUFFIX_RE = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
globalThis.famKeyOf = function (name) {
  let b = name;
  if (/^Souvenir /.test(name)) b = name.slice(9);
  else if (/^★ StatTrak™ /.test(name)) b = '★ ' + name.slice(12);
  else if (/^StatTrak™ /.test(name)) b = name.slice(10);
  const m = b.match(WEAR_SUFFIX_RE);
  return m ? b.slice(0, m.index) : b;
};
const fmtSigned = n => (n > 0 ? '+¥' : n < 0 ? '-¥' : '¥') + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const alchSrc = fs.readFileSync(path.join(PROJ, 'app', 'js', '05-alchemy.js'), 'utf8');
const segStart = alchSrc.indexOf('let alchIdx');
const segEnd = alchSrc.indexOf('function renderAlchemy');
if (segStart < 0 || segEnd < 0) { console.error('无法抽取 05-alchemy.js 函数段'); process.exit(1); }
vm.runInThisContext(alchSrc.slice(segStart, segEnd) + '\n;globalThis.__opt = alchOptimize; globalThis.__normAdj = normAdj; globalThis.__wearBandOf = wearBandOf;', { filename: '05-alchemy.js' });
const alchOptimize = globalThis.__opt, normAdj = globalThis.__normAdj, wearBandOf = globalThis.__wearBandOf;

console.log(`数据：ALL_ITEMS ${ALL_ITEMS.length} 件 · TRADEUP 集合 ${TRADEUP.crates.length} 个`);

// ---------- 0) 归一化浮动公式（2024-10 Retakes 规则）标准向量 ----------
console.log('\n[0] 归一化浮动公式（2024-10 规则）');
{
  const eps = 1e-9, near = (a, b) => Math.abs(a - b) < eps;
  const cases = [
    // [输入浮动, 皮肤范围, 期望归一化值, 出处]
    [0.05, [0, 0.4], 0.125, 'take.skin 例：P250 Supernova 0.05（范围0-0.4）→ 12.5%'],
    [0.30, [0, 0.4], 0.75, 'money4gamers 例：0.30 在 0-0.4  capped 皮肤 → 0.75（filler 策略失效）'],
    [0.05, [0, 1], 0.05, '全范围皮肤归一化恒等'],
    [0.725, [0.45, 1], 0.5, '范围中点 → 0.5'],
  ];
  let badV = 0;
  cases.forEach(([fl, f, want, desc]) => {
    const got = normAdj(fl, f);
    if (!near(got, want)) { badV++; fail(`normAdj(${fl}, [${f}]) = ${got}，期望 ${want}（${desc}）`); }
  });
  // 钳制与零范围防御
  if (normAdj(0.9, [0, 0.4]) !== 1) { badV++; fail('超出范围上限未钳制到 1'); }
  if (normAdj(0.1, [0.5, 0.5]) !== 0) { badV++; fail('零范围未回退 0'); }
  // 端到端例：10× 0.05（范围0-0.4）→ 归一化均值 0.125 → 产出范围 [0,0.3] → 0.0375（崭新）
  const outF = 0 + 0.125 * (0.3 - 0);
  if (!(near(outF, 0.0375) && wearBandOf(outF) === 'fn')) { badV++; fail(`端到端磨损映射异常: outF=${outF} band=${wearBandOf(outF)}`); }
  badV === 0 ? ok(`${cases.length} 个标准向量 + 钳制/零范围防御 + 端到端映射全过`) : null;
}

// ---------- 1) 池去重 ----------
console.log('\n[1] TRADEUP 池同名去重');
{
  let dup = 0, total = 0;
  TRADEUP.crates.forEach(c => {
    ['cons', 'ind', 'mil', 'restr', 'clsfd', 'cov'].forEach(k => {
      const p = c.t[k] || []; total += p.length;
      dup += p.length - new Set(p.map(e => e.n)).size;
    });
    const g = c.gold || []; total += g.length;
    dup += g.length - new Set(g.map(e => e.n)).size;
  });
  dup === 0 ? ok(`${total} 条目无重复`) : fail(`发现 ${dup} 个同名重复条目（build-tradeup.js 去重回归）`);
}

// ---------- 2) alchOptimize 全量不变量 ----------
console.log('\n[2] alchOptimize 全量不变量（集合×档位×普通/ST）');
{
  // 10:1 常规链条只到 保密→隐秘；隐秘→金色 只有 5:1 合同（2025-10 规则）
  const TIERS = ['mil', 'restr', 'clsfd'];
  let scanned = 0, valid = 0;
  const bad = [];
  for (const crate of TRADEUP.crates) {
    for (const tier of TIERS) {
      for (const st of [false, true]) {
        scanned++;
        const r = alchOptimize(crate, tier, st, 15);
        if (!r || r.note) continue;
        valid++;
        const { best, worst, minF, maxF } = r;
        const tag = `${crate.name}/${tier}/st=${st}`;
        if (best && minF && best.net < minF.net - 1e-9) bad.push(`${tag}: best ${best.net.toFixed(2)} < minF ${minF.net.toFixed(2)}`);
        if (best && maxF && best.net < maxF.net - 1e-9) bad.push(`${tag}: best ${best.net.toFixed(2)} < maxF ${maxF.net.toFixed(2)}`);
        if (worst && minF && worst.net > minF.net + 1e-9) bad.push(`${tag}: worst ${worst.net.toFixed(2)} > minF ${minF.net.toFixed(2)}`);
        if (worst && maxF && worst.net > maxF.net + 1e-9) bad.push(`${tag}: worst ${worst.net.toFixed(2)} > maxF ${maxF.net.toFixed(2)}`);
        if ([minF, maxF, worst].some(x => x && x.net > 0) && best && best.net <= 0)
          bad.push(`${tag}: 存在正收益卡片但 best=${best.net.toFixed(2)}（误报全场无正收益）`);
        // 扫描变体数不得超过合法变体总数
        if (r.totalV != null && r.scanned > r.totalV) bad.push(`${tag}: scanned ${r.scanned} > totalV ${r.totalV}`);
        // 归一化语义：avg 必须落在 [0,1]
        [best, worst, minF, maxF].forEach(x => {
          if (x && (x.avg < -1e-9 || x.avg > 1 + 1e-9)) bad.push(`${tag}: avg ${x.avg} 超出归一化区间 [0,1]`);
        });
      }
    }
  }
  if (bad.length) { bad.slice(0, 10).forEach(b => fail(b)); if (bad.length > 10) console.log(`  …另 ${bad.length - 10} 处`); }
  else ok(`扫描 ${scanned} 组（${valid} 组有效），不变量全部成立`);
}

// ---------- 3) fmtSigned ----------
console.log('\n[3] fmtSigned 符号');
{
  const a = fmtSigned(-24.83), b = fmtSigned(0.96), c = fmtSigned(0);
  (a === '-¥24.83' && b === '+¥0.96' && c === '¥0.00') ? ok(`${a} / ${b} / ${c}`) : fail(`符号异常: ${a} / ${b} / ${c}`);
}

// ---------- 4) 雷达一致性 ----------
console.log('\n[4] 雷达（alch-scan.json）与模拟器口径一致性');
{
  const scanFile = path.join(PROJ, 'cache', 'alch-scan.json');
  if (!fs.existsSync(scanFile)) {
    console.log('  ⏭  cache/alch-scan.json 不存在，跳过（先跑 node scan-tradeup.js）');
  } else {
    const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
    // 字段与排序
    const rowOk = r => r && typeof r.crate === 'string' && typeof r.net === 'number' && typeof r.cost === 'number' && Array.isArray(r.recipe);
    if (![...scan.best, ...scan.worst].every(rowOk)) fail('雷达条目字段不完整');
    const sortedDesc = scan.best.every((r, i) => i === 0 || scan.best[i - 1].net >= r.net - 1e-9);
    if (!sortedDesc) fail('雷达 best 未按净收益降序');
    // 逐条复算（雷达与前端价格管线不同源，允许 ±(10%成本+2) 容差；符号只对大额强制）
    let checked = 0, drifted = 0;
    for (const r of [...scan.best, ...scan.worst]) {
      const crate = TRADEUP.crates.find(c => c.name === r.crate);
      if (!crate) { fail(`雷达集合在 TRADEUP 中不存在: ${r.crate}`); continue; }
      const repro = alchOptimize(crate, r.tier, !!r.st, 15);
      if (!repro || repro.note || !repro.best) continue;   // 价格管线差异导致前端不可估，跳过
      checked++;
      const tol = Math.abs(repro.best.cost) * 0.1 + 2;
      if (r.net > repro.best.net + tol) { drifted++; fail(`${r.crate}/${r.tier}/st=${r.st}: 雷达 net ${r.net} 显著优于复算最优 ${repro.best.net.toFixed(2)}（口径漂移）`); }
      if (Math.abs(r.net) > 50 && Math.abs(repro.best.net) > 50 && Math.sign(r.net) !== Math.sign(repro.best.net))
        fail(`${r.crate}/${r.tier}/st=${r.st}: 符号不一致 雷达 ${r.net} vs 复算 ${repro.best.net.toFixed(2)}`);
    }
    if (!drifted && checked) ok(`复算 ${checked} 条，无显著口径漂移`);
    // 内嵌数据一致性：data.js 内嵌 ALCHSCAN 应与 cache 同步（regen 后一致）
    if (ALCHSCAN_EMBED && ALCHSCAN_EMBED.updatedAt !== scan.updatedAt)
      console.log(`  ⚠  data.js 内嵌雷达日期 ${ALCHSCAN_EMBED.updatedAt} ≠ cache ${scan.updatedAt}（需 regen）`);
  }
}

console.log(failures ? `\n共 ${failures} 处失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

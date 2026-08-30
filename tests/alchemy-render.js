// 渲染级验证：用 jsdom 真实加载 index.html + 全部脚本，导航到炼金页，检查关键区块
'use strict';
const path = require('path');
const { JSDOM } = require(path.join('C:', 'Users', 'chenzhao', 'WorkBuddy', '2026-08-29-11-04-52', 'cs-skin-monitor', 'node_modules', 'jsdom'));

const APP = 'C:/Users/chenzhao/WorkBuddy/2026-08-29-11-04-52/cs-skin-monitor/app';
let failures = 0;
const fail = m => { failures++; console.log('  ❌', m); };
const ok = m => console.log('  ✅', m);

JSDOM.fromFile(path.join(APP, 'index.html'), {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'file://' + path.join(APP, 'index.html')
}).then(dom => {
  const w = dom.window;
  w.addEventListener('error', e => fail('页面运行时错误: ' + e.message));
  setTimeout(() => {
    try {
      console.log('[1] 脚本加载');
      ['renderAlchemy', 'render'].forEach(k => {
        if (typeof w[k] === 'undefined') fail(`全局 ${k} 不存在`);
      });
      // state 为 const 声明不挂 window，由后续导航行为间接验证
      ok('核心全局函数已加载（render/renderAlchemy）');

      console.log('[2] 导航到炼金页（#/alchemy）');
      w.location.hash = '#/alchemy';
      w.dispatchEvent(new w.Event('hashchange'));

      setTimeout(() => {
        try {
          const html = w.document.getElementById('app') ? w.document.getElementById('app').innerHTML : '';
          if (!html) { fail('app 容器为空（白屏）'); report(); return; }
          const has = s => html.indexOf(s) >= 0;
          console.log('[3] 炼金页面关键区块');
          has('炼金模拟器') ? ok('模拟器标题') : fail('缺「炼金模拟器」标题');
          has('今日炼金雷达') ? ok('今日炼金雷达（UI 恢复验证）') : fail('缺「今日炼金雷达」');
          has('极值公式扫描') ? ok('极值公式扫描') : fail('缺「极值公式扫描」');
          has('归一化') ? ok('归一化口径展示') : fail('缺「归一化」字样');
          has('10:1 普通升级') && has('5:1 刀具/手套') ? ok('双模式 chips') : fail('缺模式 chips');
          !has('隐秘→金色') ? ok('10:1 隐秘→金色已移除') : fail('仍存在 10:1 隐秘→金色');
          has('alch-scan-row') ? ok('雷达行可点击载入') : fail('缺雷达行');
          // 槽位行数
          const slots = (html.match(/alch-idx/g) || []).length;
          slots === 10 ? ok('10 个输入槽位') : fail(`槽位数 ${slots} ≠ 10`);
          // 假收益防护：默认应显示可信净收益或无价提示
          has('净收益') ? ok('净收益卡片存在') : fail('缺净收益卡片');
          // 选一个纪念包再渲染，验证警示横幅
          console.log('[4] 纪念包警示横幅');
          const sel = w.document.getElementById('alchCrate');
          if (sel) {
            const svnIdx = [...sel.options].findIndex(o => /Souvenir/.test(o.value) || /Souvenir/.test(o.textContent));
            if (svnIdx >= 0) {
              sel.value = String(svnIdx);
              sel.dispatchEvent(new w.Event('change'));
              setTimeout(() => {
                const html2 = w.document.getElementById('app').innerHTML;
                html2.indexOf('alch-svn-warn') >= 0 ? ok('纪念包警示横幅出现') : fail('纪念包未显示警示横幅');
                html2.indexOf('不能') >= 0 ? ok('横幅文案含「不能作为输入」') : fail('横幅文案缺失');
                report();
              }, 50);
              return;
            }
            console.log('  ⚠ 未找到纪念包选项，跳过横幅检查');
          }
          report();
        } catch (e) { fail('渲染断言异常: ' + e.message); report(); }
      }, 300);
    } catch (e) { fail('导航异常: ' + e.message); report(); }
  }, 1500);
}).catch(e => { console.log('  ❌ jsdom 加载失败:', e.message); process.exit(1); });

function report() {
  console.log(failures ? `\n共 ${failures} 处失败` : '\n渲染级验证全部通过');
  process.exit(failures ? 1 : 0);
}

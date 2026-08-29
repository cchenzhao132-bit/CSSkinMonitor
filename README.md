# CS 饰品市场监测 · CS Skin Price Radar

一个**零依赖、完全本地**的 CS2（CS:GO）饰品行情监测桌面应用：真实价格、磨损价位表、武器分类、涨价/降价榜，双击即用（约 30MB，依赖系统自带 Edge WebView2）。

> ⚠️ 本项目与 Valve / Steam 无任何关联；数据来自 Steam 社区市场公开页面，仅供个人学习与行情参考，不构成任何交易建议。

![screenshot](shot-v6-real-list.png)

## 功能

- **涨价榜 / 降价榜**：覆盖全部 Steam 采集条目（约 7000+），按 7 日涨跌排序；Top3 金银铜徽章，红涨绿跌；其中热门池（~200 件）每日实时刷新，第三方参考条目历史积累满 8 天后自动入榜
- **全库搜索**：输入武器名（如 `AK-47`、中文"爪子刀"）→ 全库该系列**所有磨损 × 版本**按价格排序，每行显示当前价与 7 日涨幅；支持常用中文词映射（印花/布章/探员/音乐盒/涂鸦/挂件/武器箱/胶囊…）
- **各磨损价位表**：详情页展示同皮肤家族 崭新出厂→战痕累累（含原版 Vanilla）在 **普通版 / StatTrak™ / 纪念版** 三种版本下的真实挂牌价，当前磨损高亮、价位条对比、点价格直达该版本条目
- **分类体系**：步枪/狙击枪/手枪/冲锋枪/霰弹枪/机枪/刀具/手套 + 印花/涂鸦/音乐盒/挂件/布章/探员/胶囊/武器箱，榜单页 chips 一键筛选
- **详情页**：历史最低/当前/最高三卡 + ECharts 走势（7/30/90/全部）
- **数据外置**：exe 同目录放置 `data.js` 即自动优先加载——**刷新行情无需重新打包**

## 数据说明（重要）

| 数据 | 来源 | 时效 |
|---|---|---|
| 当前价 / 磨损挂牌价 / 分类 / 图片 | Steam 市场公开端点 | 热门池每日刷新；全库截至最近一次深度爬取 |
| **第三方参考价**（详情页） | [Skinport](https://docs.skinport.com/)、[market.csgo.com](https://market.csgo.com/en/api)、Waxpeer 公开 API | 每次运行爬虫时同步（每源 1 次请求），详情页显示与 Steam 的价差 |
| 物品目录并集 | 三方市场并集（约 3 万条） | 用于覆盖率核算与深度爬取缺口定位 |
| 价格历史 | `cache/price-history.json` 每日快照 | **运行越久越真实**；不足 8 天的条目回退本地模拟走势（页面已标注） |
| 7 日涨跌幅 | 由价格历史计算 | 快照 ≥8 天后为真实值，之前为演示模拟 |

- **多源原则**：Steam 挂牌价是唯一行情口径（本应用的定位）；第三方现货市场价（Skinport/market.csgo/Waxpeer）口径为真实货币现金价，通常低于 Steam 钱包价 20-30%，仅在详情页作为跨平台比价参考，明确标注来源，绝不与 Steam 价混用
- 汇率：USD → CNY 固定 `7.25`（`--rate` 可调），与国内平台（BUFF/悠悠有品）报价不可直接对比
- 想立即获得真实历史？见下方「可选：真实历史层」

## 快速开始

### 普通用户

下载 release 中的 `CSSkinMonitor.exe`（或自行打包），双击运行。刷新行情：

```
node crawler.js            # 热门层，约 2 分钟
node crawler.js --regen    # 重建 app/data.js
# 把 app/data.js 复制到 exe 同目录，重启应用即可
```

> **clone 后第一步**：`node crawler.js` + `node crawler.js --regen` 生成 `app/data.js`（数据文件为生成物，不入库）。

### 环境要求

- Node.js ≥ 16（爬虫仅用 Node 内置模块 + 系统 `curl`）
- Python 3.10+（仅打包 exe 时需要；`pip install -r requirements.txt`）
- Windows 10+（WebView2 系统自带）

### 打包

```
python -m PyInstaller --onefile --windowed --name CSSkinMonitor --add-data "app;app" main.py
```

## 爬虫设计（分层）

```
node crawler.js                      # 热门层：Steam 热门前 200 条，~2 分钟，榜单数据源 + 每日快照
node crawler.js --mode weapons       # 深度层：34 种武器全量（普通/StatTrak/纪念 × 各磨损）
node crawler.js --mode knives        # 深度层：20 类刀具 + 8 类手套全量
node crawler.js --mode collect       # 深度层：印花/涂鸦/音乐盒/挂件/布章/探员/胶囊/武器箱
node crawler.js --regen              # 离线重建 data.js（不访问网络，不刷新价格）
node crawler.js --reset              # 清空缓存重新抓
```

- **分层动机**：全市场 ~3.5 万条目全量爬取需数小时；实际行情关注点集中在热门池，深度层低频补全即可
- **多源目录**（`sources.js`）：每轮运行从 Skinport / market.csgo.com / Waxpeer 各取 1 次公开价格表（共 3 次请求 ≈ 近 3 万条），生成 `cache/catalog.json` 物品目录并集 + 覆盖率报告，并为详情页提供第三方参考价；单源失败自动跳过
- **断点续传**：进度落盘 `cache/crawler-cache.json`，中断重跑自动续传；已收录条目仅刷新价格
- **限流**：列表页 3.5s/请求、历史层 3s/请求，失败指数退避重试 3 次
- **修复翻页**：Steam 无视 `count` 参数固定返回 ~10 条/页 → 按实际返回数自适应推进
- **磨损价位库**：`WEARDB[皮肤家族] = { cat, w: 普通版, st: StatTrak™, sv: 纪念版 }`，键 `fn/mw/ft/ww/bs/van`
- **过滤参数说明**：Steam 未登录时 `category_730_*` 过滤参数会被忽略，收藏品改用关键词搜索 + `type` 字段归类

### 可选：真实历史层（默认关闭）

Steam 的 `pricehistory` 端点需要登录会话。若你愿意用**自己的账号会话**补齐真实历史（合规约定：仅本人会话、仅抓本人可见的公开行情、3s 限流）：

```
# STEAM_COMMUNITY_COOKIE 换成浏览器里 steamcommunity.com 的 Cookie 值
set STEAM_COMMUNITY_COOKIE=steamLoginSecure=xxxxx...
node crawler.js --history 200          # 为热门池前 200 件拉取真实价格历史
node crawler.js --regen
```

若你的 Steam 钱包币种是美元，加 `--hist-usd`（默认按人民币口径入库）。不配置则完全不影响使用，历史靠每日快照自然积累。

**第三方条目免登录回填**：Skinport 公开成交历史（24h/7d/30d/90d 窗口成交中位价）可为第三方条目立即构建真实涨跌：

```
node crawler.js --pages 0 --backfill 2000   # 按 7 日成交量优先回填（每批 100 名称、限流 40s，2000 条约 13 分钟）
node crawler.js --regen
```

- 回填过的条目立即获得**真实**涨跌分类并进入涨跌榜；7 天成交不足 3 次的低流动性物品保持「无数据」（中位数不可信）
- 回填进度记录在 `cache/catalog.json`（`histAt`），重跑自动续传；全量约 1.9 万条一个晚上（~2 小时）可完成

## 合规声明

- 遵循 [steamcommunity.com/robots.txt](https://steamcommunity.com/robots.txt)：本项目用到的 `/market/search/render/` 均不在禁止清单内
- 第三方市场仅使用官方公开文档 API（Skinport / market.csgo.com / Waxpeer），遵守其文档限流（Skinport 8 次/5 分钟，本项目每轮 1 次），来源在应用内明确标注
- 不登录、不破解任何访问控制；所有数据为匿名（或你本人账号）在浏览器中同样可见的公开数据
- 固定限流 + 重试退避，不对任何服务造成不合理负担；请勿绕过、修改或移除限流参数后大量抓取
- 物品图片版权归 Valve 所有，本仓库不入库图片（运行时从 Steam CDN 加载或本地缓存，仅供个人使用）
- 请勿将本项目数据用于商业转售；使用本项目产生的任何行为由使用者自行负责

## 项目结构

```
cs-skin-monitor/
├── main.py                      # pywebview 入口（支持启动路由参数 + 外置 data.js 覆盖）
├── crawler.js                   # 分层爬虫（热门/武器/刀具/收藏品 + 磨损价位库 + 价格快照 + 多源目录）
├── sources.js                   # 第三方市场源（Skinport / market.csgo.com / Waxpeer，公开 API）
├── crawler-templates/engine.js  # 运行时引擎（真实历史接入/榜单/分类/SVG 兜底）
├── app/                         # 前端（原生 HTML/CSS/JS + 本地 ECharts，无构建步骤）
│   ├── index.html / styles.css / app.js
│   └── data.js                  # 爬虫生成（RAW + WEARDB + HISTORY + engine）
├── cache/                       # 爬虫缓存 + 每日价格快照 + 多源目录（gitignore）
└── requirements.txt
```

## 技术选型

- **打包**：pywebview + PyInstaller（弃 Electron——体积 1/7；复用系统 WebView2）
- **图表**：ECharts 5 本地内嵌，完全离线
- **爬虫**：Node + spawn curl（Steam 拒绝 Node TLS 指纹，curl 正常）
- **前端**：原生 JS 单页应用，hash 路由，长列表 60 条/批 + IntersectionObserver 懒加载

## Roadmap

- [ ] 真实历史积累完善后的涨跌榜自动切换说明
- [ ] 价格提醒（webhook）
- [ ] 多币种支持
- [ ] 深度层定时任务示例（Windows 计划任务 / cron）

## 致谢与参考

- [scm-price-history](https://github.com/HilliamT/scm-price-history) —— 无登录价格历史思路（经实测 Steam 改版后已失效，本项目改用每日快照积累 + 可选官方 pricehistory 端点）
- [cs2-price-tracker](https://github.com/spratap124/cs2-price-tracker) —— 限流/退避/缓存实践参考
- [awesome-cs2-trading](https://github.com/redlfox/awesome-cs2-trading) —— CS2 交易工具合集

## License

[MIT](LICENSE)

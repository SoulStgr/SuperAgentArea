# UI 审查报告：dsh-superagent（SuperAgentArea）浏览器管理面板

> 审查对象：`H:\DTB_AIToos\superAgent\dsh-superagent-fusion`（git 基线 `73dfd0f Initialize`，单提交快照）
> 审查方式：**只读代码 + 文档**，未运行面板、未改任何源码；本报告是 `plan/00-总体方案.md` §13 第 1 步的输入。
> 引用约定：`文件:行号` 均相对仓库根；凡「实际渲染效果」无法从代码断定的地方，标 **未验证**。
> 结论口径：本报告评价的是**信息架构与可维护性**，不是视觉审美；每条判断都有代码位置。

---

## 0. 摘要（先给结论）

1. **面板的数据模型落后于产品模型一个版本**：Artifact（产物）已在后端落库并投递（`src/app/artifacts.ts:70-82`、`src/kv.ts:66`），但没有任何 API 路由（`src/app/api.ts:20-46`）或界面区块；folder 源只能靠「执行环境变量」看到交付目录（`src/app/execution-environment.ts:27-43`），产物列表、下载、投递记录在界面上不存在。这是「界面大改」最该补的一块。
2. **导航模型是自研内存路由**：6 个 Tab + 5 个设置组 + 多处第三层子 Tab，路由只写 `sessionStorage`（`src/client/route.ts:49-67`），没有 URL、浏览器后退无效、无法深链接；切 Tab 会清空历史栈（`src/client/app.tsx:183-184`），从工单详情切走就回不去。
3. **状态语言至少有 5 套并行实现**（圆点、Tag、StageMark/彩色文本、左侧色条、banner；Toast 是第 6 套提示通道），术语表只解释 5 种圆点（`src/client/app.tsx:46-48`），且同一中文词覆盖多个概念（「执行中」4 处、「准入」2 个概念、`historySource` 4 组同义键）。
4. **页面骨架重复且层级混乱**：4 个状态页共用 H2「状态」（`src/client/widgets.tsx:118-125`），H2 字号 15/16/20 并存；详情页关键动作沉底（Stop 在页面最后，`src/client/ticket.tsx:192-196`）。
5. **改版的技术自由度被测试锁住**：`src/client` 禁止任何运行时 `@deepseek-ai/*` 导入（`tests/controls.spec.tsx:12-19`），CSS 是 `?raw` 全局注入（`src/client/provider.tsx:104`）并受「一行一规则、不得有未使用类」约束（`tests/styles.spec.ts:9-29`），9 个面板测试文件共 94 个用例按**文案文本**找元素（`tests/fixtures/panel.tsx:48-52`）。改版必须同时规划测试与文档表的迁移（`tests/docs.spec.ts:60-69`）。

---

## 1. 现状清单

### 1.1 客户端模块与体量

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/client/locales.ts` | 773（约 735 个键、63 KB） | 中英双语字典 + 术语表分组（`:8-752`、`:758-769`） |
| `src/client/client.css` | 382（208 个 `dt-` 类） | 全局面板样式，一行一规则（`:1` 注释即约定） |
| `src/client/prompts.tsx` | 295 | 提示词编辑/完整预览/历史 |
| `src/client/settings-kit.tsx` | 278 | 设置表单套件、块草稿、字段渲染、历史 |
| `src/client/controls.tsx` | 250 | 自绘 UI 基元（对照 DSH ui-primitives 的仿制，`:1-4`） |
| `src/client/draft.tsx` | 203 | 草稿状态机、三方合并、保存条 |
| `src/client/ticket.tsx` | 198 | 工单详情 |
| `src/client/app.tsx` | 188 | 外壳：header/搜索/术语表/Tabs/路由分派 |
| `src/client/thread.tsx` | 176 | 线程详情 |
| `src/client/source.tsx` | 156 | 来源状态 + 来源设置卡 |
| `src/client/widgets.tsx` | 147 | 页面级复用件（Section/LoadState/PageHead…） |
| `src/client/api.ts` | 140 | 同源 API 客户端 + `usePoll` |
| `src/client/rows.tsx` | 140 | 工单/线程/决定三类行 |
| `src/client/execution.tsx` | 127 | 执行状态 + 执行设置 |
| `src/client/provider.tsx` | 108 | 轮询、重启探测、action runner、Toast |
| `src/client/overview.tsx` | 103 | 概览 |
| `src/client/deployment.tsx` | 100 | 部署设置 + Plugin Manager 配置页 |
| `src/client/marks.ts` | 57 | 领域状态 → 视觉标记 |
| `src/client/route.ts` | 67 | 路由模型与历史 |
| `src/client/trigger.tsx` | 27 | 线程列表 |

### 1.2 入口与 DSH 槽位

| 槽位 | 注册 | 作用 |
|---|---|---|
| `main`（keyed） | `src/client/index.tsx:53-54`，key=`dsh-superagent` | 管理面板主体，挂在侧栏图标选中的中央面板 |
| `sidebar.panellist` | `src/client/index.tsx:55`，order=10，图标 `HammerIcon`（`:24-28`） | 侧栏入口，标签 `t('panel')`=SuperAgentArea |
| `plugins.row.config` | `src/client/index.tsx:56-57` | DSH Plugin Manager 的插件配置页；`view==='summary'` 时返回 `null`（`src/client/deployment.tsx:98-99`），由 DSH 显示包描述（`locale/*.json`） |

依赖注入 `inject = ['slots','locale','sessions','uiWorkspace']`（`src/client/index.tsx:48`）；`configForms` 为可选，缺失时部署页只读（`:44`、`src/client/deployment.tsx:33-51`）。打开 Session 走 `ctx.uiWorkspace.openSession`（`:38`），带 `navigation.ts` 的就绪校验（`src/navigation.ts:14-23`）。

### 1.3 Tabs / 页面 / 子视图

`TABS = ['overview','source','trigger','eval','execution','settings']`（`src/client/route.ts:7`）；`SETTINGS_GROUPS = ['source','eval','execution','prompts','deployment']`（`:9`）。路由分派在 `src/client/app.tsx:147-160`。

| Tab | 路由 | 组件 | 数据来源 | 主要区块 |
|---|---|---|---|---|
| 概览 | `{page:'overview'}` | `overview.tsx:61-102` | `GET overview`（`:64`，5 s） | 待处理工单（`:75-79`）、系统问题（`:80-83`）、过去 24 小时流水（`:84-93`）、执行器（`:94-101`） |
| 来源 | `{page:'source'}` | `source.tsx:141-156` | `GET sources`（`:144`，5 s） | 每源一行：状态点、24 h 到达/过滤、最近时间、setup 问题、健康注记、被过滤（折叠，`:125-135`）、未发送（折叠，`:136`） |
| 触发 | `{page:'trigger'}` + `?filter` | `trigger.tsx:10-26` | `GET threads`（`:13`，5 s） | 4 个过滤 Pill（`:19-21`）、线程行、`LoadMore`（`:25`） |
| 评估 | `{page:'eval'}` + `?filter&window` | `eval.tsx:15-39` | `GET decisions`（`:18`，5 s） | 5 个过滤 Pill（`:29-31`）、24 h 开关（`:32`）、决定行、`LoadMore` |
| 执行 | `{page:'execution'}` + `?filter` | `execution.tsx:14-51` | `GET tickets`（`:19`，5 s）+ `StateView` | 执行器状态行 + 暂停（`:29-38`）、5 个过滤 Pill（`:40-42`）、工单行 |
| 设置 | `{page:'settings', query.group}` | `settings.tsx:13-38` | `GET settings`（`settings-kit.tsx:26`，5 s） | 左侧 5 组导航（`:27-32`）+ 组标题（`:34`）+ 组内容 |

详情路由（`route.ts:11-17`）：

| 详情 | 路由 | 组件 | 数据 | 区块（按渲染顺序） |
|---|---|---|---|---|
| 线程 | `{page:'trigger', id, ?trigger}` | `thread.tsx:108-176` | `GET threads/:key`（`:75`，5 s；`around`/`before` 分页，PAGE=50 `:67`） | 页头+原文链接（`:129`）、元信息行（`:131-134`）、评估中 banner（`:135-138`）、订阅工单（`:140-143`）、决定（折叠，`:144-149`）、关联线程（`:150-155`）、时间线（`:156-168`）、退订危险区（`:169-174`） |
| 工单 | `{page:'execution', id}` | `ticket.tsx:108-197` | `GET tickets/:id`（`:110`，5 s） | 页头+重试+Session（`:129-135`）、状态行（`:137-142`）、结束提示（`:143`）、待人工决定 banner（`:144-148`）、失败/受阻 banner（`:150-152`）、送达失败 banner（`:153-155`）、授权详情（`:156`、`:68-106`）、未送达输入（`:157-160`）、订阅线程（`:161-164`）、折叠区（派工/环境变量/渠道/已送达输入/标识，`:165-191`）、停止危险区（`:192-196`） |

设置组（`src/client/settings.tsx:17-25`）：`source`→`SourceSettings`（来源卡，`src/client/source.tsx:61-68`）；`eval`→`PolicyBlock`+`EvalBlock`+`ConfigHistory`（`src/client/eval.tsx:219-224`）；`execution`→执行器/执行环境（`src/client/execution.tsx:75-127`）；`prompts`→三视线编辑器（`src/client/prompts.tsx:29-68`）；`deployment`→机器上限 + 账号派生值（`src/client/deployment.tsx:33-86`）。

第三层子视图（不在路由里）：Prompts 的 `编辑/完整提示词/历史`（`src/client/prompts.tsx:40`、`:54-59`）、Policy 的「在各来源上」子 Tab（`src/client/eval.tsx:143-144`、`:176-181`）、来源卡内「高级」折叠（`src/client/source.tsx:51-54`）。

### 1.4 导航与搜索模型

- **导航**：`navigate(route, replace)` 压栈，栈上限 20（`src/client/app.tsx:180-181`）；`back()` 弹栈（`:182`）；切 Tab 时 `stack=[]`（`:183-184`）；设置组切换用 `replace=true`（`src/client/settings.tsx:30-31`）故不产生历史。
- **记忆**：`sessionStorage['dsh-superagent/route']` 存 `{route, stack, group}`（`src/client/route.ts:49-67`），每次 location 变化写入（`src/client/app.tsx:175`）；`parseRoute` 丢弃失效页与失效过滤器，包括遗留的 `policy` Tab（`route.ts:31-47`）。
- **页面标题**：`routeLabel` 只用于详情页返回按钮文案（`route.ts:23-24`、`app.tsx:185`）；品牌标题恒为 `t('title')`（`app.tsx:125`），不随路由变化。
- **搜索**：header 内联表单，回车提交 `GET search`（`app.tsx:116-123`），结果下拉在表单内部（`:130`），点外部/Escape 关闭（`:110-115`、`:127`）；结果分三组：工单（≤10）、线程、触发（≤20，超出提示 `searchFoundCapped`，`app.tsx:77`、服务端 `src/app/views/threads.ts:76,87`）；被来源过滤的触发不给链接而给过滤原因（`app.tsx:90-96`）。**无键盘导航、无 scope、无分页、只高亮第一处匹配**（`app.tsx:57-61`）。

### 1.5 轮询与刷新

| 数据 | 间隔 | 位置 |
|---|---|---|
| `GET state`（面板级） | 5000 ms（重启探测期 1000 ms，30 s 超时） | `src/client/provider.tsx:74,89-98` |
| `GET settings`（每个 SettingsProvider 一份） | 5000 ms，并在重启计数变化时立即重读 | `src/client/settings-kit.tsx:23-32` |
| 页面级列表/详情（overview/sources/threads/decisions/tickets） | 5000 ms（`usePoll` 默认） | `src/client/api.ts:67-98`，各页调用处见 §1.3 |
| Plugin Manager 配置页 | 10000 ms | `src/client/deployment.tsx:99` |
| 提示词 | 一次性 `GET prompts`，保存后重读 | `src/client/prompts.tsx:24-26` |
| 模型目录 | 一次性 `GET models` | `src/client/settings-kit.tsx:76` |

`usePoll` 行为：串行排队（无并发请求）、页面隐藏时 ×6 退避、响应与上次相同则不重渲染、依赖变化丢弃旧响应（`src/client/api.ts:60-98`）。**`fetch` 无超时/无 AbortSignal**（`src/client/api.ts:37`），请求悬挂会卡住整个队列（`:75-88`）。

### 1.6 状态展示方式（6 套并行）

| 机制 | 定义 | 语义 |
|---|---|---|
| 状态点 `Dot`/`StateDot` | `src/client/controls.tsx:140-152`；颜色 `client.css:231-235` | `done/warning/ongoing/error/idle`；`ongoing` 渲染旋转环（`:141-148`） |
| 阶段标记 `StageMark` | `src/client/widgets.tsx:104-107`；样式 `client.css:341-345` | 图标 + 文字 + 状态色，用于工单/线程/决定行（`src/client/rows.tsx:19,57,87`） |
| Tag 语气 | `src/client/controls.tsx:62-65`；7 种语气 `client.css:198-205` | 去向、过滤原因、授权依据等 |
| 彩色状态文本 | `client.css:272-275` | `data-state` 仅区分 warning/error |
| 左侧色条 + banner | `client.css:292-296,323-325,25-26` | 问题行、待人工行、横幅 |
| Toast | `src/client/provider.tsx:65-71,106`；`client.css:261-267` | 操作成功/失败提示，3 s 后淡出 |

领域状态到标记的映射集中在 `src/client/marks.ts`：工单（`:9-23`）、线程（`:27-38`）、来源（`:40-46`）、决定（`:48-57`）。

---

## 2. 界面问题（按严重度）

### P0 — 影响「能不能用」

**U1 零深链接：无 URL、浏览器后退无效、跨 Tab 丢上下文**
路由只存在 `sessionStorage`（`src/client/route.ts:49-67`），全客户端无 `location`/`history.pushState` 调用（grep 结果为零）。后果：
- 无法把「某工单」发给同事，也无法从文档/聊天跳到某条工单或线程；
- 浏览器后退按钮不改变面板（只在 `sessionStorage` 内压栈）；
- 切换 Tab 清空历史（`src/client/app.tsx:183-184`）：从工单详情点「触发」再点返回，回到的是 Trigger 列表而不是工单；
- 新标签页/复制标签页一律回到 HOME（`route.ts:53-64`）。
测试也是用 `sessionStorage` 模拟深链（`tests/fixtures/panel.tsx:79`），说明当前「深链」只是测试内的假象。

**U2 状态语义过载：同一个中文词指多个状态，图例不覆盖**
- 「执行中」同时是：设置项标签（`locales.ts:94`）、工单过滤（`:395`）、工单阶段（`:355`）、派工报告（`:280`）；
- 「准入」同时是 `term.gate`（Gate，`:631`）与 `admission`（Admission，`:251`）；
- 「停止」同时是工单危险动作（`:52`）、决定结果（`:24`）、结束结果（`:275`）、报告状态（`:290`）。
- 图例只解释 5 种圆点（`app.tsx:46-48`），但界面上还有 7 种 Tag 语气、StageMark 图标色、banner 色、左侧色条；颜色语义互不复用（例如 `warning` 在 Tag、`.dt-status-text`、`.dt-att` 上是三种色值来源，`client.css:204,274,293`）。
- `ongoing` 在每条列表行渲染一个旋转 SVG（`controls.tsx:141-148`）；`prefers-reduced-motion` 下旋转被整体关掉（`client.css:264-267`），此时「进行中」退化为一个静态灰环，与 `idle` 只能靠色相区分。

**U3 部分「问题」不可操作，违反自家设计原则**
`docs/005-panel.md:57` 原则 6 要求「Problems must be actionable」，但：
- `runtime-error`（`src/client/overview.tsx:39`）没有任何按钮；
- `outgoing` 回复发送失败（`:55-57`）没有「重发/忽略」，只显示错误原文；
- 来源健康异常只能跳设置（`src/client/source.tsx:115-120`），没有「重新轮询/重连」；
- `LoadState` 只有一行错误文本，没有重试按钮，且 `reload` 没有传入（`src/client/widgets.tsx:108-112`；对比各页都持有 `reload`，如 `src/client/source.tsx:144` 丢弃了它）。
- 错误发生时旧数据继续显示且无 stale 标记（`src/client/api.ts:81-83`、`src/client/overview.tsx:74`）。

### P1 — 影响「好不好用」

**U4 信息层级混乱：4 个页面同名「状态」，标题字号三套**
`StatusHead` 在来源/触发/评估/执行 4 页渲染同一个 H2 `t('statusTitle')`＝「状态」（`src/client/widgets.tsx:118-125`，调用处 `source.tsx:148`、`trigger.tsx:17`、`eval.tsx:23`、`execution.tsx:28`）——Tab 已经说了页面是什么，H2 却四页同字。字号：品牌 H1 15 px（`client.css:13`）、状态页 H2 15 px（`:271`）、设置块标题 16 px（`:18`）、详情页 H2 20 px（`:133`）、区块标题 13 px（`:20`）。层级不靠尺寸表达，只靠间距。设置页又把组名同时放在导航和标题里（`src/client/settings.tsx:30,34`）。

**U5 详情页太长，关键动作沉底**
工单页从上到下 10 段（`src/client/ticket.tsx:129-196`）：重试在页头（`:131-133`）、停止在页面最后（`:192-196`）、派工默认折叠且「只有 >1 次才显示」（`:167`）、产物无位置。线程页的「重新评估」默认 `opacity: 0`，只有 hover 才出现（`client.css:67-68`；`src/client/thread.tsx:50`），触屏靠 `@media (hover:none)` 兜底（`client.css:69-71`）。`requeue` 的可发现性依赖鼠标。

**U6 列表行的动作依赖于调用方是否传参，行为不一致**
`TicketLine` 只有传入 `onChanged` 才渲染重试/停止/回答（`src/client/rows.tsx:31-41`）。执行页只给 `person` 阶段的工单传了 `onChanged`（`src/client/execution.tsx:46-48`），所以在「进行中」过滤下，一个失败/受阻但阶段已变的工单行看不到重试，必须点进详情页；概览页给所有待处理工单都传了（`src/client/overview.tsx:76`）。同一行组件在不同页面能力不同。

**U7 搜索过于单薄，且提示文案对 folder-only 部署是错的**
无键盘上下选择、无 `role=listbox`/`aria-activedescendant`（`src/client/app.tsx:74-97`）、结果不可分页、只覆盖工单/线程/触发三类实体（`src/app/views/threads.ts:59-88`），没有产物、路径、策略、提示词。空结果文案按「是否配置飞书」二选一（`src/client/app.tsx:76`）：folder-only 部署（`setup.accounts.feishu` 为 null）会得到「可以输入…GitHub PR 或 Issue 链接、#编号」（`locales.ts:109`），而该部署根本没有 GitHub 源（`src/deployment.ts:96-97`）。

**U8 术语表只是个静态长表**
- 27 个词条、5 种状态色、4 组取值，无搜索、无分类跳转、无锚点（`src/client/app.tsx:34-52`）；
- 词条与含义直接从字典取（`app.tsx:42` 的 `own[...]`/`other[...]`），绕过 `t()`，DSH 的语言覆盖机制对它无效；
- 中英判定靠字符串比较（`app.tsx:29`：`t('tab.overview') === zh['tab.overview']`），DSH 侧翻译一旦与内置中文相同即判反；
- 词条不含新领域概念：Artifact、投件/交付目录、收件箱、产物哈希均无 `term.*`/`meaning.*`（`locales.ts:758-764`；`artifact` 仅在健康码 `locales.ts:47` 出现）；
- 同义键冗余：`historySource.panel` 与 `historySource.web`（`locales.ts:67,71`）、`tool` 与 `orchestrator-tool`（`:69,73`）、`sync` 与 `policy-sync`（`:70,75`）、三个 `*-migration` 都是「升级迁移」（`:76-78`）。

**U9 空/加载/错误态同质化，几乎没有信息量**
全部是单行 `t('loading')`＝「正在读取…」（`src/client/app.tsx:146`、`widgets.tsx:111`）或单行错误（`widgets.tsx:110`）；无骨架、无「正在读取第几页」、无空态引导动作（空态文案如 `threadsNone`/`none` 只陈述没有，`locales.ts:177,50`）。新建/首次使用场景下（无来源、无工单）界面几乎空白，只能靠概览的 `problems` 兜底。

**U10 窄屏与宽屏都没有为面板本身做布局**
- 内容列固定 `max-width: 960px` 居中（`client.css:7`），而 DSH 的三栏框架给中央列的空间通常远大于 960 px（侧栏 264–420 px、右栏按需让位，`.../dsh-client-ui-layout/README.md:30`；实际像素**未验证**），宽屏下两侧留白明显；
- 断点只有 640 px 容器查询（`client.css:169-185,317-322,355-358`）与两个 media 查询（`:69,264`）；DSH 中央列在窄窗口可低于 400 px（`node_modules/@deepseek-ai/dsh-client-ui-layout/README.md:95`），401–639 px 区间没有任何专门布局；
- Tabs 组件写死内联 `gridTemplateColumns`（`src/client/controls.tsx:106`），但页面 CSS 把同一元素改成 `display:flex`（`client.css:15`，选择器权重更高），内联栅格失效；`data-more` 的渐隐遮罩只在 ≤640 px 生效（`client.css:178-180`），641–960 px 溢出时无提示；
- 准入表 3 列 + 两层表头（`src/client/eval.tsx:121-131`）没有横向滚动容器，只有表头 `white-space: nowrap`（`client.css:372`），窄屏可能溢出（**未验证**）。

**U11 重复信息（同一事实多处展示）**
- 执行器负载：概览（`src/client/overview.tsx:94-101`）与执行页（`src/client/execution.tsx:29-38`）；
- 策略版本：Eval 设置（`src/client/eval.tsx:160-163`）、工单详情（`src/client/ticket.tsx:99-104`）、配置历史（`src/client/settings-kit.tsx:150-151`）；
- 来源标题+描述：来源状态页（`src/client/source.tsx:108`）与来源设置卡（`:39`）；
- 设置组名：左导航与页标题（`src/client/settings.tsx:30,34`）。

**U12 三层 Tab 叠加，Tab 命名与内容不符**
一级 6 Tab（`route.ts:7`）→ 设置内 5 组（`:9`）→ 页面内 3 个子 Tab（`src/client/prompts.tsx:54-59`、`src/client/eval.tsx:176-181`）。且「触发」Tab 实际列的是**线程**（`src/client/trigger.tsx:10-26`），文档也写「Threads filtered by…」（`docs/005-panel.md:21`）；`route.ts:31` 的注释还在解释已删除的 `policy` Tab——说明 Tab 集合已经历过一次语义漂移。

### P2 — 一致性与细节

**U13 决定日志丢了「为什么」**
`decisionView` 已提供 `strength`、`direction`（实施意图/依据/证据）、每条规则的原因（`src/app/views/records.ts:196-208`），但 `DecisionLine` 只渲染规则名与过滤原因（`src/client/rows.tsx:78-102`）；这些信息只在工单详情的授权块里出现（`src/client/ticket.tsx:88-97`）。Eval 页看不到强度、方向证据，也没有「按规则/策略版本筛选」。

**U14 时间显示不自动走时**
`when()` 是纯函数，相对时间在渲染时计算（`src/client/text.ts:45-59`），只在轮询或重渲染时更新；提示词页无轮询（`src/client/prompts.tsx:24-25`），停留时「3 分钟前」会停住。完整时间只在 `title` 上（`src/client/widgets.tsx:12-15`）。

**U15 folder 渠道渲染空链接**
folder 的 `channel.link` 返回 `url: ''`（`src/sources/folder.ts:134`），工单页「渠道」折叠区无守卫地渲染 `<ExternalLink href={item.url}>`（`src/client/ticket.tsx:176-180`、`src/client/widgets.tsx:97-99`），代码上会产出 `href=""` 的锚点，点击会重载当前页（**未验证**实际点击效果）。

**U16 CSS 组织方式带来的摩擦**
单文件 382 行、全局作用域、`dt-` 前缀、一行一规则（`client.css:1`）；同一组件的外观被页面级选择器覆盖（`.dt-page .dt-tab`，`client.css:268-269` 覆盖 `:209-213`）；缩进量在多处硬编码 28 px（`client.css:103,168`）。组件的「设计」分散在 `controls.tsx` 与 `client.css` 两处，改版时容易只改一边（`styles.spec.ts` 只能验证类名被使用，不能验证组合关系）。

---

## 3. 功能缺口

### 3.1 后端已有、界面没有

| # | 缺口 | 后端事实 | 界面现状 | 影响 |
|---|---|---|---|---|
| G1 | **Artifact 列表与下载** | `ready` 报告时收集 `deliver/` → 写 `KV.artifacts(ticketId)` → 复制到 `<outbox>/<ticket>/artifacts` → 发结果回复（`src/app/artifacts.ts:70-82`；键族 `src/kv.ts:66`） | **零呈现**：API 契约无产物路由（`src/app/api.ts:20-46`），工单详情视图无产物字段（`src/app/views/tickets.ts:56-86`），客户端只用到健康码 `health.artifacts`（`src/client/locales.ts:47`） | 「交付 = 回复 + 产物」是产品核心（`plan/00-总体方案.md:152-159`），现在操作者只能去文件夹翻 |
| G2 | **folder 源的可读呈现** | 多行 `folders{id,inbox,outbox}` 配置（`src/sources/folder.ts:18-27,117-121`）；单一健康条目 `health:['folder']`（`:125`）；投件线程以 `drop.rel` 命名（`:185`） | 来源状态页只有 kind 级健康（`src/app/views/sources.ts:13-21`）；收件/交付目录只在设置卡的行编辑器里（`src/client/settings-kit.tsx:167-239`）；工单页只能从环境变量表看到 outbox 路径（`src/client/ticket.tsx:169-175`）；渠道是空链接（见 U15） | 投件方（操作者）无法在面板确认「目录配对了吗、上次投件几点、为什么没进工单」 |
| G3 | **多源并存 / 同 kind 多实例的身份** | `instances()` 每个已注册 kind 恰好一个实例（`src/sources/registry.ts:119-123`）；来源标题只取 kind 标题（`src/app/views/sources.ts:20`） | 来源状态行只渲染标题（`src/client/source.tsx:108`），不显示实例 id；策略子 Tab 同样用 kind 标题（`src/client/eval.tsx:176-181`） | 阶段 2 引入钉钉/QQ/SFTP 后，若同 kind 多实例，界面无法区分 |
| G4 | **GitHub 可选后的文案** | 无仓库即合法部署（`src/deployment.ts:96-97`），`github` 可为空（`:57-61`） | 面板部署页把「仓库/智能体/飞书」显示为 `—`（`src/client/deployment.tsx:56-70`，`accounts` 只在 Plugin Manager 传，`:93`）；搜索空态仍提 GitHub（`src/client/app.tsx:76`、`locales.ts:109`）；插件页描述仍是「监听单个 GitHub 仓库」（`locale/zh.json:4`） | 用户不知道「我没配 GitHub」是不是错 |
| G5 | **工单的产物/交付记录** | 送达失败有 `deliveryError`（`src/app/views/records.ts:127`）；结果回复与产物同一事务（`src/app/artifacts.ts:76-81`） | 只有一行送达失败 banner（`src/client/ticket.tsx:153-155`），无「产物 N 个 / 已投递到 X / 结果回复已发出」 | 复盘时无法回答「到底交付了什么」 |
| G6 | **搜索覆盖 folder 线程与产物** | 触发文本可被 LIKE 命中（`src/app/store-read.ts:54-57`）；folder 未实现 `find`（`src/sources/kind.ts:104` 可选，github 有 `src/sources/github.ts:67`、feishu 只有 terms `src/sources/feishu.ts:67`、folder 无） | 搜 task 文件夹名时，若 `TASK.md` 正文不含该名字则搜不到；产物名/哈希完全不可搜 | 「投件后找回」这条最自然的操作路径断裂 |
| G7 | **Eval/Decision 可读性** | 决定带 `strength`、`rules[].reason`、`direction`（`src/app/views/records.ts:196-208`） | 日志不显示强度/方向，规则原因只在工单页（见 U13） | 调策略时缺少证据 |
| G8 | **Policy 的可读性** | 策略版本是哈希（`src/policy.ts`），历史记录变更（`src/app/settings-history.ts`，视图 `src/client/settings-kit.tsx:123-161`） | 只显示 8 位短码（`src/client/eval.tsx:161`）；无可视 diff、无「这条规则上次命中过哪些触发」的回放 | 改规则靠猜 |
| G9 | **Prompts 编辑体验** | 保存有占位符/长度校验（`src/app/prompts.ts`、`locales.ts:724-726`） | 纯 textarea（`src/client/prompts.tsx:136-137,172-173`，最小高 360 px `client.css:117`）；无 Markdown 预览、无段内字符数；**完整提示词页每敲一个键就 POST 一次**（`prompts.tsx:189-194`，依赖 `config` 对象身份，无防抖） | 长文编辑体验差，且预览接口被打满 |
| G10 | **模型/预算** | 角色模型只用于「新建 Session 首次请求」（`src/app/role-models.ts:14-19`），已有 Session 保持自己的选择；预算/租约尚未实现（`plan/00-总体方案.md:186-189`） | 只有两个全局下拉输入（研判 `src/client/eval.tsx:211-213`、执行器 `src/client/execution.tsx:97-98`），用原生 `<datalist>`（`src/client/settings-kit.tsx:96-102`）；工单页不显示实际模型 | 无法回答「这单用的是哪个模型、花了多少」 |
| G11 | **已计算但界面未使用** | `flow.triggers`、`flow.evaluating`（`src/app/views/overview.ts:75-76`）、`policyVersion`（`:77`）、`state.health`（`src/app/http.ts:105-110`） | 客户端从不读取这些字段（grep：`policyVersion` 只出现在设置/工单页，`state.health` 零使用） | 概览缺「评估中」计数；健康面板只能通过问题列表间接感知 |

### 3.2 界面有、但已过时

| # | 现状 | 过时点 |
|---|---|---|
| S1 | 搜索空态分「有无飞书」两版（`src/client/app.tsx:76`、`locales.ts:108-109`） | 判据是飞书而非「启用了哪些源」；folder-only / 多源部署都会给错提示 |
| S2 | 部署页「仓库与账号」在面板内不显示（`src/client/deployment.tsx:59,66-70`） | GitHub 变成可选后，面板内没有任何地方说明「未配 GitHub 是正常的」 |
| S3 | `locale/zh.json`、`locale/en.json` 描述「监听单个 GitHub 仓库」（`locale/zh.json:4`、`locale/en.json:4`） | 与多源（GitHub/飞书/folder）事实冲突，会显示在 DSH Plugins 列表 |
| S4 | `docs/005-panel.md:15-24` 的 Tab 表 | 「Trigger」行描述的是 Threads；无产物、无 folder 相关说明；新增面板能力需同步 |
| S5 | `Search` 文档只写触发/线程/工单（`docs/005-panel.md:44-48`） | 与 G6 缺口同源：文档固化了「只有三类实体」的搜索 |
| S6 | 术语表不含 Artifact/投递/收件箱（`locales.ts:758-764`） | 产品核心概念无词条 |

---

## 4. 大改的技术约束与风险

### 4.1 DSH client slot 机制

- 主面板是**带 key 的 `main` 槽**（`src/client/index.tsx:53-54`），没有 Session 绑定；组件必须自带全部数据获取与滚动（见 4.2）。面板按 key 被 `ctx.layout.selectPanel` 选中，key 变更等于换一个面板；DSH 的布局状态在页面刷新后重置（`.../dsh-client-ui-layout/README.md:12`），所以「上次停在哪个面板」只能靠面板自己的 `sessionStorage`（`src/client/route.ts:49-67`）。
- 侧栏入口是 `sidebar.panellist`，注册参数只有 `{id, order, label, locale}` 与图标组件（`index.tsx:55`）；图标 owner props 只有 `{size, active}`（`node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:93-99`），**面板图标自身没有 badge/count 位**；可承载提示的只有侧栏收起时的 `sidebar.toggle.badge`（同文件 `:17-22`）与框架级 `shell.overlay`（`node_modules/@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts:85-98`）。
- 插件配置页走 `plugins.row.config`，必需支持 `view: 'summary' | 'page'`（`node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:21-26`）；现在 `summary` 返回 `null`，依赖 `locale/*.json` 的包描述（`src/client/deployment.tsx:98-99`），改版若想在这里放摘要，必须同时改 locale json 与 `client.spec.tsx:52-60` 的断言。
- `inject` 缺一项即整个客户端插件不加载（`index.tsx:48`）；`configForms` 缺失时部署页降级为只读（`:44`、`deployment.tsx:33-51`）——改版不能假设它一定存在。

### 4.2 作为 main panel 的尺寸/滚动约束

- 面板自己拥有滚动：`.dt-page { height:100%; overflow:auto }`（`client.css:2`），内容列 960 px 居中（`:7`），因此**任何新布局都必须把高度约束在这一层内**，不能用整页 `position:fixed`（Modal/Toast 已是 portal 到 `document.body`，`controls.tsx:203-215`、`provider.tsx:69`）。
- 中央列在 DSH 中可缩到 400 px 以下（`.../dsh-client-ui-layout/README.md:95`），侧栏在 <1024 px 自动收起（`:30`）；容器查询只有 640 px 一档（`client.css:169,317,355`）。
- 顶部安全区只处理了 macOS：`[data-platform='darwin'] .dt-head { padding-top: var(--dsh-frame-top-clearance) }`（`client.css:12`），Windows 由 caption 行占位（README `:41`）——跨平台改版需保持这个不对称处理，否则 macOS 会压到红绿灯。
- 粘性元素（保存条 `client.css:151`、设置导航 `:302`）的 sticky 上下文就是 `.dt-page`；把某页改成独立滚动容器会一并破坏它们。

### 4.3 provider 的轮询与错误处理

- `usePoll` 是**串行队列**（`src/client/api.ts:75-88`）：一个慢请求会推迟后续所有轮询；`fetch` 没有超时（`:37`），没有 AbortSignal，所以「服务端卡住」在界面上表现为整页停在旧数据且没有提示。
- 错误与数据并存（`api.ts:81-83`），页面各自决定是否显示旧值（`overview.tsx:74` vs `execution.tsx:45`），改版应统一成「stale + 重试」策略。
- 重启探测在渲染期直接 `setRestarting`（`provider.tsx:90-93`）——幂等但属于 render 副作用，React 升级或严格双渲染下需复核（**未验证**）。
- Toast 是自绘 3 秒提示（`provider.tsx:65-71,106`），错误与成功同一样式；改版若要接入 DSH 通知，需要新增依赖（见 4.5）。

### 4.4 自研路由（无 URL 同步）

- 路由是纯 TS 联合类型 + 解析器（`route.ts:11-47`），历史是 `sessionStorage`（`:49-67`），App 持 `location` 状态（`app.tsx:174-184`）。
- 现状**没有任何与浏览器 URL 的同步**（无 `history`/`location` 调用）。改版若要深链，需要决定：用 hash（`#/execution/<id>`）还是 DSH 提供的面板路由（当前 DSH `main` 槽按 panel id 选择，没有子路由 API，`.../dsh-client-ui-layout/README.md:32`）。**未验证** DSH 是否有可用的面板内路由服务。
- 已有路由记忆带来一个隐形契约：`sessionStorage` 键与形状（`route.ts:49,55-58`）在改版后若格式变化，必须像 `parseRoute` 那样容错（`:32-47`），否则用户刷新会白屏/丢页（当前实现是安全的，可作为迁移范式）。

### 4.5 CSS 体系

- 单个全局样式表，通过 `?raw` 导入成字符串，再由 `PanelProvider` 注入 `<style>`（`src/client/provider.tsx:104`；`tsdown.config.ts:4-8` 的 raw 插件；`src/client/css.d.ts`）。
- 所有类 `dt-` 前缀（208 个），依赖 DSH `--dsw-alias-*` 设计令牌（`client.css:2,192-205` 等），并有针对 Plugin Manager 内嵌场景的覆写（`:4-6`）。
- **不能直接换 CSS Modules/样式组件**：
  - 打包侧目前只支持 `?raw`（`tsdown.config.ts:4-8`），换方案要改构建；
  - `tests/styles.spec.ts:9-15` 要求「CSS 里的每个类都必须被某个组件用到」，`:17-29` 要求「一行一规则、同块选择器不重复」；
  - `tests/controls.spec.tsx:21-34` 要求客户端模块图无环。
  可行路径：保留全局表但按页拆文件 + 统一 `dt-<page>-` 命名；或引入 CSS-in-JS（新增依赖会被打进客户端 bundle，`tsdown.config.ts:11-12` 只外置 react）。
- 类名与语义已经绑定（如 `.dt-att`、`.dt-status-line` 内含负 margin `client.css:134`），改版改名会连带改测试与截图基线（当前无截图测试）。

### 4.6 locale 字典的维护成本

- 一个 63 KB、约 735 键的对象，`as const satisfies Record<string, readonly [string,string]>`（`locales.ts:752`），`zh`/`en` 由同一定义派生（`:754-755`）；键类型 `DshSuperagentKey` 供 `t()` 类型检查（`:753`、`text.ts:9`）。
- 硬约束：中英占位符必须一致、不得为空（`tests/locales.spec.ts:9-13`）；`USER_ERRORS`（44 个，`src/core/errors.ts`）、`REASONS`（20 个，`src/core/reasons.ts`）、健康码、setup 码必须全部有词（`locales.spec.ts:27-42`；字典里共 48 个 `reason.*` 键，多出的是策略/来源侧原因）；DSH 侧用 `ctx.locale.register(NS, {zh,en})`（`index.tsx:51`）。
- 成本点：新增一个页面/状态往往要同时改 `locales.ts`、`marks.ts`、`GLOSSARY`（若为新概念）、`docs/007-architecture.md` 模块表；术语表又把 `term.*`/`meaning.*` 与页面词条耦合在同一个文件里。

### 4.7 测试保护与改版冲击面

现状：`tests/panel-*.spec.tsx` 9 个文件、**94 个用例**（deployment 7、eval 10、execution 12、overview 13、panel 8、prompts 15、settings 6、source 15、trigger 8），全部通过 `mount()` 渲染完整 `App`，用 `textContent`/`aria-label` 找控件（`tests/fixtures/panel.tsx:38-52`），用假 API 服务（`tests/fixtures/panel-server.ts:296`，类型 `{ [K in keyof Api]: Route<K> }`）。

| 测试 | 锁定内容 | 改版影响 |
|---|---|---|
| `panel-overview/source/trigger/eval/execution.spec.tsx` | 每页区块顺序、文案、动作 | **大面积重写**（页面结构与文案都变） |
| `panel-settings.spec.tsx` | 保存条、历史、分组顺序与「返回上次分组」 | 中：分组重排即需改 |
| `panel-prompts.spec.tsx`（15 例） | 三视线、冲突、默认更新 | 中：保留功能则多数可复用 |
| `panel-deployment.spec.tsx` | 部署表单、只读态、重启轮询 | 小—中 |
| `panel-panel.spec.tsx` | 搜索、术语表、路由记忆 | 中：深链/搜索一改即重写 |
| `client.spec.tsx:52-60` | 注册顺序、槽位 key、侧栏标签 'SuperAgentArea' | 小但**必改**（改名/加槽位） |
| `controls.spec.tsx:12-19` | 客户端零 DSH 运行时导入 | **架构级**：想用 DSH 原生组件必须先改这条 |
| `controls.spec.tsx:41-97` | Modal 焦点、Tabs 键盘 | 复用控件则保留 |
| `styles.spec.ts:9-29` | CSS 类使用与书写规范 | 新增/删除页面必改 |
| `locales.spec.ts` | 键完整性与占位符 | 新增状态必改 |
| `docs.spec.ts:60-69` | `src` 每个模块、`tests` 每个 spec 都必须登记在 `docs/007-architecture.md` 的模块/测试表 | **新增/删除任何客户端文件都要改文档表**，否则 CI 红 |
| `class-docs.spec.ts` | 每个 class 上方必须有 JSDoc | 新类需注释 |

另外：新增 API 路由会让 `tests/fixtures/panel-server.ts:296` 的类型映射编译失败（因为 `Api` 是逐路由枚举），即「后端加路由 → 前端测试夹具必须同步」，这对产物功能是好事（强制补测试），但要计入工作量。

### 4.8 版本与构建风险

- 客户端产物是 CJS + 自定义 loader banner（`tsdown.config.ts:11-13`），只外置 react/react-dom；新增运行库会直接进 `lib/client.js`。
- 声明依赖 `dsh ^0.2.1-alpha.2`（`package.json` engines），而 `plan/00-总体方案.md:59` 记录本机 DSH 为 `0.2.2-rc.5`；slot 契约若在改版期间漂移，注册处（`index.tsx:50-57`）是唯一的适配点，应集中封装。
- 架构约束「client 只 import 宿主类型」（`docs/007-architecture.md:258`；`tests/controls.spec.tsx:12-19`）意味着**面板与 DSH 原生 UI 的融合只能停留在令牌与行为模仿层面**，除非显式修改这条约束。

---

## 5. 改版建议（信息架构草案）

### 5.1 设计原则（沿用并补强）

1. 一个对象一个页面：工单、产物、线程、来源、策略、提示词各一处，不再用「状态页 + 设置页」复制同一对象。
2. 每页只有「列表 → 详情」两层；第三层（Prompts 三视、Policy 来源子 Tab）改为页内分段，不再叠 Tab。
3. 问题必须带动作；没有动作的事实不进入「问题」，进入详情。
4. 「投件 → 触发 → 评估 → 工单 → 派工 → 产物 → 复盘」是主链，界面上每一步都能点到下一步与上一步（当前链在「产物」断开）。
5. 颜色只表达一种语义：状态色只由 `DotState` 一套产生，Tag 只表达分类，不再新增第三套色语义。

### 5.2 建议的新导航结构

一级（侧栏图标选中的中央面板内，6→7）：

```
工作台 Workbench        （默认）
工单   Tickets
产物   Artifacts        ← 新增，自一级页面承载交付结果
线程   Threads          ← 由「触发」更名（它列的是线程）
来源   Sources          ← 列表 + 源详情（状态与配置合一）
策略   Policy & Eval    ← 决定日志 + 规则/准入/评估设置合并
提示词 Prompts          ← 从 Settings 提升为一级
                        设置（齿轮，非 Tab）：执行器/执行环境/部署/源配置入口
```

理由：现在 6 Tab 中「设置」里有 5 组，其中 Prompts 与 Policy 都是高频、重编辑的页面；把它们放一级，设置只留低频的机器与部署项。设置入口从 Tab 移到 header 齿轮（减少一个 Tab 位），保留现有页内 5 组左导航作为设置页内部结构。

二级：每页的过滤用 Pill（沿用 `Pill`，`controls.tsx:67-70`），详情用「返回 + 标题 + 状态行」，不再使用同名 H2「状态」。

### 5.3 每页核心信息块

| 页面 | 首屏信息块（按优先级） | 详情页 |
|---|---|---|
| 工作台 | ① 需要我处理（工单 + 一键回答/重试/停止）② 系统问题（每条带动作）③ 24 h 流水（到达/过滤/评估/接单/未发送/产物）④ 执行器与队列 ⑤ 最近交付的产物 | 无 |
| 工单 | 过滤：进行中/待处理/执行中/等待触发/已结束；行：阶段、授权强度、线程 chips、产物数、最近时间 | 授权 → 输入 → **产物（新增）** → 交付记录（新增）→ 订阅线程 → 派工 → 执行环境 → 结束复盘；重试/停止常显在页头 |
| 产物 | 时间倒序索引：文件、工单、来源、目录、大小、哈希；可下载/复制路径 | 无（或侧滑详情） |
| 线程 | 过滤：订阅/评估中/24 h/全部；行：阶段、最新一条、扇出目标 | 时间线（重评常显）→ 决定（含强度/方向/规则原因）→ 订阅工单 → 退订 |
| 来源 | 每源一行：状态、收件范围、24 h 计数、最近投件、问题（带动作） | 源详情：健康分项、收件/交付目录、配置表单（原设置卡）、过滤/未发送列表、最近投件 |
| 策略 | 策略版本 + 规则列表 + 准入表 + 评估设置；决定日志作为「最近决定」区块（或子页） | 决定的完整证据（规则原因、方向证据、策略版本） |
| 提示词 | 编辑/完整/历史三视保留，改为页内分段而不是页内 Tab 条 | — |
| 设置 | 执行器、执行环境、部署上限、账号派生值、状态目录 | — |

### 5.4 关键交互流程

```
投件（folder drop / IM 消息 / Issue）
  └─ 来源详情：看到投件 → 触发
       └─ 线程详情：时间线 + 重评
            └─ 策略/评估：决定 + 理由（强度、规则原因、方向证据、策略版本）
                 └─ 工单：授权 + 输入 + 派工（重试/停止）
                      └─ 产物：列表 + 下载 + 交付目录 + 哈希
                           └─ 复盘：结束结果/原因 + 派工次数 + 产物数 + 时间线
```

每一步都要有「回上一步」的显式链接（不是隐藏历史）：线程 →「打开工单」已有（`thread.tsx:48-49`），工单 →「打开线程」需补，产物 →「打开工单」需新增。

### 5.5 与 DSH 原生界面风格的融合

1. **保留**：`--dsw-alias-*` 令牌、`dt-` 前缀、`controls.tsx` 已有键盘/焦点行为（Modal 焦点陷阱、Tabs 方向键）。
2. **对齐**：标题与正文的字号/行高按 DSH 的 15/13 两级收敛；列表行密度与 DSH 会话列表一致；空态/加载态用 DSH 的措辞（而不是「正在读取…」单行）。
3. **可选升级**：若要真正复用 DSH 组件，需要（a）放宽 `tests/controls.spec.tsx:12-19` 的「零运行时导入」约束，（b）新增 `@deepseek-ai/dsh-client-ui-*` 依赖并加入 `package.json` 的 `dsh.client.inject`，（c）重写 CSS 中自绘基元部分。建议在改版定稿阶段做一次「引入 vs 继续仿制」的显式决策（见 §6-3）。
4. **面板级提示**：待办角标用 `shell.overlay` 或侧栏收起态的 `sidebar.toggle.badge`（`.../dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:17-22`）而不是改侧栏图标（图标 props 只有 `{size, active}`）；操作反馈优先用 DSH 通知，自绘 Toast 仅在 POC 期保留。
5. **文档标题**：当前 `<h1>` 恒为品牌名（`app.tsx:125`），建议随页面变化（`document.title` 由面板设置；与 DSH `DocumentTitle` 是否冲突**未验证**）。

### 5.6 页面级结论（保留 / 合并 / 删除 / 新增）

| 页面/形态 | 结论 | 说明 |
|---|---|---|
| 概览 Overview | **保留→改造为工作台** | 去掉执行器重复块（并入顶部条），补「评估中/产物」计数，问题条目全部带动作 |
| 来源状态 Source | **合并** | 与来源设置卡合并为「来源 → 源详情」，配置在详情内编辑 |
| 触发 Trigger（列表） | **保留→更名线程** | 内容本来就是线程；过滤项保留 |
| 线程详情 Thread | **保留→加强** | 重评常显、决定证据前移、补「打开工单」 |
| 评估 Eval（决定日志） | **合并** | 并入「策略」页，作为「最近决定」区块/子页 |
| 执行 Execution（列表） | **保留→工单** | 暂停动作移到工作台与工单页头；执行器状态移除重复 |
| 工单详情 Ticket | **保留→重构** | 加产物/交付/复盘，动作上提 |
| 设置 Settings | **保留→瘦身+去 Tab 化** | 只留执行器/环境/部署/账号；Prompts、Policy、来源配置移出 |
| Prompts | **提升为一级** | 三视改页内分段 |
| Deployment | **保留在设置内** | 账号派生值应在面板内可见（修 G4） |
| 术语表 Glossary（模态） | **保留→改成可搜索抽屉/页** | 加 Artifact/投件/交付目录等词条，改从 `t()` 取值 |
| 全局搜索 | **升级** | 覆盖产物/路径/决定/策略版本；加键盘导航 |
| 产物页 Artifacts | **新增** | 全局交付索引 |
| 源详情页 | **新增** | 每源的收件/交付/健康/最近投件 |
| 深链 | **新增能力** | hash 或 DSH 面板路由（待定，见 §6-4） |

### 5.7 迁移顺序（建议）

1. 外壳与路由（新一级导航 + 可深链路由 + 统一页头）——先不动业务页。
2. 工单 + 产物（含后端 `GET tickets/:id/artifacts`、`GET artifacts` 与下载/路径接口）——收益最大。
3. 来源（状态+配置合一，folder 收件/交付目录）。
4. 线程 + 策略/评估（决定证据、重评常显）。
5. 提示词（预览防抖、页内分段）。
6. 设置收口（执行器/部署/账号派生值）+ 术语表/搜索升级。
每步：先改 `tests/panel-*.spec.tsx` 对应文件与 `tests/fixtures/panel-server.ts`，同步 `docs/007-architecture.md` 模块/测试表与 `docs/005-panel.md`，`pnpm check` 绿后再进下一步。

---

## 6. 待确认问题清单（需产品决策，≤8 条）

1. **一级导航选哪个方案**：保留 6 Tab 重排，还是采用 §5.2 的「工作台/工单/产物/线程/来源/策略/提示词 + 设置齿轮」？（对应 `plan/00-总体方案.md:230` 的待决策 7；本报告建议后者。）
2. **产物是否一等公民**：新建「产物」一级页，还是先只在工单详情加产物块（阶段 1 文档的最小方案，`plan/00-总体方案.md:158`）？
3. **是否引入 DSH 原生组件**：接受放宽「客户端零运行时 DSH 导入」约束（`tests/controls.spec.tsx:12-19`）与新增依赖吗？还是继续自绘基元、只对齐令牌与行为？
4. **深链接形态**：用 URL hash（`#/tickets/<id>`）还是等 DSH 提供面板内路由？是否需要「从聊天/文档点链接直接打开某工单」？
5. **同 kind 多实例**：是否要支持「多个 GitHub 仓库 / 多个 folder 实例」各自独立状态与健康？若是，来源模型与界面身份（标题/健康/策略）要一起改（当前 `instances()` 每 kind 一个，`src/sources/registry.ts:119-123`）。
6. **术语收敛**：Trigger 是否一律改称 Thread 为主对象？Admission 与 Gate 中文都叫「准入」如何区分？Execution/Executor 中文「执行/执行器」是否保留？
7. **搜索范围**：是否把产物、路径、提示词、策略版本纳入搜索（涉及后端索引与权限），以及是否升级为命令面板（可执行动作）？
8. **多语言与术语表**：面板继续自带中英术语表（`docs/005-panel.md` 的「界面只显示一种语言」），还是与 DSH 全局语言/文档统一，术语表只保留术语对照？

---

## 附录 A：未验证清单

- 所有实际渲染效果：本报告只读代码，未启动面板；窄屏/宽屏、hover 显隐、粘性条遮挡、admission 表溢出均为代码推断（**未验证**）。
- 键盘与屏幕阅读器实测（Tabs 方向键、Modal 焦点陷阱的逻辑有测试，`tests/controls.spec.tsx:41-97`；其余页面无）。
- folder 渠道空 `href` 的浏览器行为（`src/client/ticket.tsx:176-180`）。
- DSH 版本差异：仓库 devDeps 为 `0.2.1-alpha.2`，本机运行的 DSH 版本见 `plan/00-总体方案.md:59`；slot 契约在运行版本上的行为未验证。
- `POST prompts/preview` 的逐键调用是否被服务端限流/缓存（代码无防抖，`src/client/prompts.tsx:189-194`）。
- 产物文件的浏览器下载可行性（尚无接口，需先定 API 形态）。

## 附录 B：一句话证据索引（便于评审快速核对）

| 结论 | 关键位置 |
|---|---|
| 6 Tab / 5 设置组 | `src/client/route.ts:7,9` |
| 路由仅 sessionStorage | `src/client/route.ts:49-67`、`src/client/app.tsx:174-184` |
| 切 Tab 清空历史 | `src/client/app.tsx:183-184` |
| 搜索三实体、上限 20/10 | `src/app/views/threads.ts:76,87` |
| 轮询默认 5 s、隐藏 ×6 | `src/client/provider.tsx:74`、`src/client/api.ts:60,85` |
| 4 页同名 H2「状态」 | `src/client/widgets.tsx:118-125` |
| 产物落库无接口 | `src/app/artifacts.ts:70-82`、`src/kv.ts:66`、`src/app/api.ts:20-46` |
| folder 渠道空链接 | `src/sources/folder.ts:134`、`src/client/ticket.tsx:176-180` |
| folder 单一健康条目 | `src/sources/folder.ts:125` |
| GitHub 可选 | `src/deployment.ts:96-97` |
| 面板内不显示账号 | `src/client/deployment.tsx:59,93` |
| 客户端零 DSH 运行时导入 | `tests/controls.spec.tsx:12-19` |
| CSS 全局 + 约束测试 | `src/client/provider.tsx:104`、`tests/styles.spec.ts:9-29` |
| 735 键单文件字典 | `src/client/locales.ts:8-755` |
| 94 个面板用例 | `tests/panel-*.spec.tsx`（9 文件） |
| 文档表强制登记 | `tests/docs.spec.ts:60-69` |

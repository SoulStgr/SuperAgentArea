# 23 工作站 Agent 要求与对话

> 需求（2026-11-26）：每个工作站（Project）的 agent 段要能由操作者填写「要求与规则」（人设 / 强制方向），可新增、编辑、删除；工作站要有一个「会话」入口，**一键进入该工作站的会话**，复用 DeepSeek Harness 的对话，不再出现「新建会话 / 选择工作区」的强制步骤；不新建多个会话，重复点击进入同一个确定性会话 `project-<projectId>`。
> 状态：已完成。0.3.17 的首版与 0.3.18 的二次调整（删除工作站 / 删除会话 / 规则编辑布局 / 发布包入 `history/`，见 §14）均以本工作区代码为准；验证见 §13 与 §14.6。

## 1. 背景与问题

工作站（`Project`）此前已经是一个一等对象：它有地址、目录、来源、工单与产物，agent 段展示「项目会话」与该项目收集的历史。但：

- **agent 段只能打开会话，不能定制。** 操作者无法告诉工作站里的 agent「你是谁、必须遵守什么」；团队提示词（安装级 / 每来源）解决的是全局规则，没有工作站级的强制方向。
- **会话入口不是「一键」。** 首次进入要经过 DeepSeek Harness 的「新建会话 / 选择工作区」空态；入口在 agent 段里，位置不显眼。
- **会话目录固定。** 项目会话总在 `scratchDir`（副本处理目录）里工作；文件夹站与有本地 checkout 的仓库站，本可以在自己的目录里对话。
- **会话身份不直观。** 会话 id 虽然已按项目固定为 `project-<projectId>`，但入口只是一句说明，重复点击的行为没有在界面上被承诺。

## 2. 目标形态

1. **工作站 Agent 的要求与规则。** 工作站记录新增可选字符串列表 `agentRules`：操作者给定的人设与强制方向。可为空；为空时**不进入任何提示词**。支持新增、逐条编辑、删除与保存。
2. **一键会话。** 工作站卡片与详情页页头都有会话入口；点击直接进入该工作站的会话，绕过 DSH 的新建会话 / 选择工作区空态；首次点击创建，之后点击打开同一个会话（确定性 id `project-<projectId>`）。
3. **会话目录按工作站地址派生。** 文件夹站用自己的文件夹，仓库站有本地 checkout 用自己的 checkout 路径，其余用工作站的副本处理目录 `scratchDir`（见 §4）。
4. **规则注入两处。** 工作站会话的系统提示段，与该工作站工单 worker 的系统提示追加段（见 §5）。规则不改变工具权限、门禁与授权，硬约束仍在代码里。

## 3. 数据模型

| 数据 | 存储 | 说明 |
| --- | --- | --- |
| agent 要求与规则 | `project.value.agentRules?: string[]`（`ProjectValue` 可选字段） | 每条 1–2000 字符、最多 50 条；HTTP 校验拒绝全空白条目；保存时去首尾空白、按原顺序去重；`[]` 或省略即清除。旧记录读取为未设置，无需 schema 迁移（Project 的 `value` 是 JSON，字段可选） |
| 会话目录 | 派生，不存储 | `conversationDirectory(project)`：见 §4 |
| 会话 id | 派生，不存储 | `projectSessionId(projectId) = project-<projectId>`；`projectIdOfSession(sessionId)` 反向解析，用于识别「这个 DSH 会话是哪个项目的会话」 |

`agentRules` 属于工作站的操作者，而不是某个工单或来源：同一工作站里由不同来源进入的工单、以及该工作站自己的会话，都读同一份要求。

## 4. 会话目录策略

| 工作站 | 会话目录 |
| --- | --- |
| `folder` 站（人指定的本地文件夹） | `location.path` |
| `repo` 站且记录了本地 `location.path`（本地 checkout） | `location.path` |
| `repo` 站只有 `url`/`branch`（尚无本地 checkout） | `scratchDir` |
| `workspace`（内置工作区） | `scratchDir` |
| `adhoc`（临时任务站） | `scratchDir` |
| 远程文件夹 / 远程主机地址 | 尚无此类地址类型，本次不支持，见 §7 |

会话目录必须是模型工具可读写的本地绝对路径：DSH 的 workspace / cwd 与文件工具都只认本地路径。`conversationDir` 同时出现在 `GET projects` 的每张卡片行与 `GET projects/:id` 的顶层，面板据此创建会话工作区。

工单来源与工作站地址是两回事：远程文件夹来源（0.3.6）说明投件来自远端，但只影响工单入口；工作站地址仍是本地文件夹 / 仓库 / 托管时，会话目录仍按本表派生。只有工作站地址本身就是远端目录时，才需要 §7 的远端会话能力。

## 5. 提示词注入

### 5.1 工作站会话

`Sessions.decorate` 识别 id 为 `project-<projectId>` 的 DSH 会话：它在 `Store.projects` 里对应的 Project 存在时，视为「工作站会话」——既不是主 Session、也不是某个工单的 worker、更不是 worker 的子代理。

- 规则非空时注册系统提示段 `dsh-superagent-workstation`（`order: 9000`，禁止变量插值），内容：

  ```text
  ## Workstation requirements (<工作站名称>)
  The operator of this workstation set these requirements for this conversation and the work here; follow them, and report a conflict with them instead of bypassing one.
  - Workstation directory: <conversationDir>
  - <规则 1>
  - <规则 2>
  ```

- 规则为空时不注册该段：会话就是一个普通 DSH 会话（不注册 dsh-superagent 的 policy 段、技能与工具限制）。
- 每条规则渲染为一行，规则内部的换行折叠为空格，避免一条要求被读成多条或成为标题。

### 5.2 工单 worker

该工作站的工单 worker 在既有 prompt（提示词版本、mandate 说明）之后追加同一份要求，但不含会话目录行：

```text
## Workstation requirements (<工作站名称>)
The operator of this workstation set these requirements for the work here; follow them, and report a conflict with them instead of bypassing one.
- <规则 1>
```

只在工单记录了 `projectId` 且该工作站有规则时追加；规则为空时 worker 的提示词与之前完全一致。

### 5.3 边界与生效时机

- 要求与规则是**提示词**，不是授权：它们不改变工具权限、Outbox、门禁、Mandate 与账号包装器；与团队提示词 / Policy 冲突时，段内文字要求「报告冲突而不是绕过」。
- **工单 worker** 的追加段写在每次模型请求都会重新求值的 prompt 段里，所以规则保存后对下一次模型请求生效。
- **工作站会话** 的要求段在会话的 Agent 被装饰时读取当时的规则（首次创建会话，或 dsh-superagent 重启后恢复该会话），是固定的段文本；已经加载的会话不会因保存规则而重建。要让它立刻读到新规则，需要重启 dsh-superagent 后重新打开该会话，或等会话下次被创建 / 恢复。这与「保存不重启、不取消、不唤醒会话」的约定一致，不承诺热更新；面板说明里的「保存后对下一次模型请求生效」对 worker 成立，对已打开的工作站会话是近似说法。
- 规则为空时不注册任何段；清空规则并保存后，新创建的会话与下一次 worker 请求都不再带要求段。

## 6. 一键会话创建流程

面板不直接暴露 DSH 的「新建会话 / 选择工作区」流程，而是按确定性 id 创建或复用会话。实现分两层：`src/navigation.ts` 的纯流程函数 `openProjectConversation(host, project, signal)`，与 `src/client/index.tsx` 里把它接到 DSH 上下文的实现。

```text
openProjectConversation({ sessions, workspaces?, open }, { id, conversationDir }, signal):
  sessionId = `project-${id}`                       // projectSessionId
  if workspaces:
    try: workspaceId = (await workspaces.create({ path: conversationDir })).workspaceId
    catch: workspaceId = undefined                   // 回退到 cwd 方式
  if aborted: return false
  if catalog 里没有 sessionId:
    try: await sessions.create(workspaceId ? { sessionId, workspaceId } : { sessionId, cwd: conversationDir })
    catch: await sessions.refresh(); 仍没有则抛出原始错误   // 多数是会话已存在（重复/并发点击）
  await sessions.refresh()                           // 让 UI 的会话树列出它，打开时不会落回选择工作区
  openKnownSession(sessions, sessionId, open, signal)
```

1. 取 DSH 的 `workspaces` 服务：`ctx.get('workspaces')`。存在时用工作站派生的目录注册 / 复用本地工作区：`workspaces.create({ path: conversationDir })` → `workspaceId`。该调用会立即合并本地 workspace 快照；**创建失败或服务不存在时回退到 cwd 方式**（直接把 `conversationDir` 作为会话的 cwd）。
2. `sessionId = projectSessionId(project.id)`。
3. `sessions.create(...)`；若抛错（最常见：会话已存在，即重复点击/并发点击），`await sessions.refresh()` 后继续——只要刷新后的目录列出该会话，就按「已存在」打开而不是报错；目录仍不解释这次失败，才把原始错误交给面板提示。
4. 打开前再 `refresh()` 一次：DSH 的会话树先列出该会话，`uiWorkspace.openSession(sessionId)` 才不会落回「选择工作区」空态。
5. `ctx.uiWorkspace.openSession(sessionId)` 直接进入该会话。
6. 面板：按钮 busy（慢的 workspace 创建期间禁用）、失败 `notify` 原始错误；被新的点击/卸载取代的请求直接放弃（AbortController）。

关键承诺：**不新建第二个会话**；重复点击永远进入 `project-<projectId>`；不再要求用户选择工作区；workspace 创建不出来时仍能开（cwd 方式）。

## 7. 远程文件夹需求（暂不实现）

### 7.1 需求

工作站地址可能是**远程文件夹 / 远程主机**（例如团队把工作站目录放在 NAS、构建机或远端服务器上）。此时操作者期望：进入该工作站的会话后，agent 能像在本地目录一样读写远端工作站目录、运行命令并交付产物。

### 7.2 为什么本次不做

- 工作站的地址模型目前只有 `managed` / `folder`（本地路径）/ `repo`（`url` + 可选本地 `path`）；没有远程地址类型。
- 会话目录必须是本地路径：DSH 的 workspace、cwd 与文件、shell 工具都在本机执行，远程目录没有本地挂载时无法作为会话目录。
- 需要远端执行器或远端 workspace 挂载、远程文件 API、路径映射、可用性与安全策略，是一整条基础设施链路（与远程文件夹来源的传输层、未来的仓库 worktree 执行都有交集），不适合塞进本阶段。
- 静默把远端工作站当成本地目录，会让 agent 在错误的目录里工作——这比不支持更糟。

因此本阶段：工作站地址仍然只有本地文件夹 / 仓库 / 托管三种；没有远端地址类型，来自远程文件夹来源的投件工单也在本地（或受管）工作站里按 §4 派生会话目录。界面与文档明确：这是本地目录，不是远端目录。

### 7.3 后续设计要点

1. **地址类型。** 扩展 `ProjectLocation`：`{ type: 'remote'; protocol: 'sftp' | 'ssh'; host; port?; path; credentialRef; knownHosts }`。复用远程文件夹来源的传输与凭据机制（仅密钥认证、`known_hosts` 强校验、不走 shell），不要把凭据写进工作站记录。
2. **远端执行器 / 远端 workspace。** 会话要真正在远端工作，需要远端 workspace provider（DSH workspace 指向远端）或远端执行器（在远端跑 dsh / worker）。本地文件工具不能直接读写远端路径，必须由远端 workspace 抽象承担文件读写。
3. **远端挂载 / 同步工作副本。** 备选：本地挂载（sshfs 或自研 FUSE 挂载）把远端目录映射为本地路径；或「拉取 → 本地修改 → 回写」的同步副本，需定义冲突、并发与一致性策略（谁赢、如何提示、漂移如何检测）。
4. **路径映射。** 远端绝对路径 ↔ 本地挂载点 ↔ 会话 cwd 的映射要显式记录；工作站要求段里的 `Workstation directory` 必须显示会话实际使用的路径，而不是远端原始路径。
5. **可用性检测。** 连接、认证、目录存在、可写探测；结果进入健康条目（例如 `workstation:<project id>`）；不可达时禁用会话入口并解释原因，而不是创建一个注定失败的会话。
6. **失败回退。** 远端不可用、挂载未就绪或探测失败时，会话回退到 `scratchDir`（本地副本），并明确标注「当前在本地副本工作」；远端恢复后提示切换，不静默把本地修改写到远端。
7. **安全与审计。** 凭据只存本机状态（`0600`，不回传面板）；远端操作使用最小能力（无 shell 或白名单命令、路径 jail 在工作站根内）；写操作与命令有审计日志；远程地址的校验与远程文件夹来源共用同一套 `pathProblem` / 主机校验。
8. **与工单执行一致。** 工单 worker 的目录同样需要远端策略（远端 checkout / 工作副本）——这一项与「仓库站 checkout/worktree」阶段合并设计，避免会话与工单在远端行为不一致。

判定：本次交付只覆盖本地目录（`folder`、有本地 `path` 的 `repo`、`scratchDir`）；地址为远程文件夹 / 远程主机的实现列入后续阶段。

## 8. 代码仓库与未来来源

- 仓库站有本地 checkout 时，会话与工单都在该 checkout 路径工作。
- 只有仓库地址、尚无本地 checkout 时，会话暂用 `scratchDir`；后续阶段补齐「按工作站地址与分支在受管目录建 clone / worktree」，作为会话目录与工单目录的共同来源（与 L2 worktree 执行阶段合并）。
- 未来来源（远程文件夹来源、IM 来源等）只是工单入口，不改变工作站地址与会话目录模型；若工作站地址是远端，按 §7 处理。

## 9. 接口

| 请求 | 说明 |
| --- | --- |
| `GET projects` | 每张工作站卡片行新增 `conversationDir`（会话目录） |
| `GET projects/:id` | 顶层新增 `conversationDir`；`project.value.agentRules` 随项目值返回 |
| `PATCH projects/:id` | 新增可选 `agentRules: string[]`：每条去空白后 1–2000 字符、最多 50 条，全空白条目被拒绝（400）；合并时按原顺序去重；空数组清除。`ProjectPatch` 类型同步 |
| 会话创建 | 不新增管理 API：会话由面板通过 DSH 的 `workspaces` / `sessions` 客户端 API 创建并打开，id 固定为 `project-<projectId>` |

## 10. 面板

- **工作站卡片：** 六个分段按钮（Sources / Trigger / Eval / Execution / Settings / agent）之后新增「会话」按钮（`Conversation`），一键进入该工作站会话；按钮忙碌时禁用。
- **工作站详情页头：** 新增「打开会话」（`Open conversation`）按钮，与归档等操作并列。
- **agent 段：** 改为「工作站 Agent 的要求与规则」+「工作站会话」两段：
  - **Agent 的要求与规则：** 标题、说明（这些要求进入该工作站会话与它工单执行器的系统提示）、逐条要求编辑（每条一个多行输入，`要求 N`；可删除）、「新增要求」（达到 50 条上限后禁用）、保存按钮（无改动时禁用）与错误提示；没有规则时显示「还没有要求或规则。」
  - **工作站会话：** 会话说明与会话 id 说明（`project-<项目 id>`，首次点击创建、之后直接打开，不再询问工作区），以及「打开会话」按钮。
  - 原有历史（工单历史、修改历史（产物）、最近报告）保留。
- 规则为空时：保存后该工作站不再有要求段；工单 worker 在下一次模型请求生效，已打开的工作站会话在下次创建或恢复时生效（见 §5.3）。

## 11. 实施切分

| 工作 | 文件 |
| --- | --- |
| 数据与派生 | `src/core/project.ts`（`ProjectValue.agentRules`、`conversationDirectory`、`projectSessionId` / `projectIdOfSession`）、`src/app/project-service.ts`（`ProjectChanges.agentRules` 的 trim/去重/清除）、`src/app/http.ts`（`PATCH projects/:id` 校验 1–2000 字符、最多 50 条）、`src/app/api.ts`（`ProjectPatch`）、`src/app/views/projects.ts`（`conversationDir`） |
| 提示词注入 | `src/app/sessions.ts`（`workstationSection` / `workRules`、`decorate` 识别 `project-<id>`、worker 追加段） |
| 会话导航 | `src/navigation.ts`（`ProjectConversation`、`WorkspaceController`、`ConversationHost`、`openProjectConversation` 的 workspace 创建 / cwd 回退 / 冲突后刷新重开） |
| 面板 | `src/client/index.tsx`（接 `ctx.get('workspaces')` 与 `uiWorkspace.openSession`）、`src/client/provider.tsx`（`PanelContext.openProjectConversation`）、`src/client/project.tsx`（卡片/页头会话入口、agent 规则编辑、工作站会话段）、`src/client/app.tsx` 透传、`src/client/locales.ts` |
| 测试 | `tests/projects.spec.ts`（会话目录派生）、`tests/resolve.spec.ts`（agentRules 保存/去重/清除）、`tests/panel-workstations.spec.tsx`、`tests/fixtures/panel-server.ts`（`conversationDir`、PATCH `agentRules`、workspace/session 假实现）、`tests/navigation.spec.ts`、`tests/panel-panel.spec.tsx` |
| 文档 | 本文件、`docs/005-panel.md`、`docs/007-architecture.md`、`plan/README.md`、`README.md`、`README.zh-CN.md` |

## 12. 验证

1. `npx vitest run tests/docs.spec.ts tests/class-docs.spec.ts tests/locales.spec.ts` 全过（编号、链接、007 模块/测试表覆盖）。
2. 受影响 specs：`tests/projects.spec.ts`、`tests/resolve.spec.ts`、`tests/panel-workstations.spec.tsx`、`tests/navigation.spec.ts`、`tests/panel-*.spec.tsx`、`tests/locales.spec.ts`、`tests/styles.spec.ts` 全过；`npx tsc --noEmit` 零错误。
3. 面板手工验证：
   - 工作站卡片「会话」与详情页头「打开会话」都一键进入会话，不出现「选择工作区」；重复点击进入同一个会话；
   - 工作站会话的目录符合 §4 策略（folder 站=文件夹、repo 本地 path=checkout、其余=scratchDir）；
   - agent 段可新增/编辑/删除要求并保存，重进页面仍在；
   - 有规则时工作站会话与工单 worker 的提示词出现 `## Workstation requirements`，清空规则后不再出现。
4. 全量 `pnpm check`（数字以收口时为准）。

## 13. 实施完成记录

> 状态：**已完成（待提交）**。提交者 `shsren-saa`。

### 13.1 完成内容

- **agent 要求与规则。** `ProjectValue.agentRules` 可选字段；`PATCH projects/:id` 接受 `agentRules`（校验每条去空白后 1–2000 字符、最多 50 条；服务端 trim、去重，空数组清除）；`GET projects` 每行与 `GET projects/:id` 顶层返回 `conversationDir`。
- **会话目录派生。** `conversationDirectory(project)`：folder 站=文件夹路径、有本地 path 的 repo 站=该路径、其余（workspace / adhoc / 无本地 path 的 repo）=`scratchDir`。
- **提示词注入。** `Sessions.decorate` 把 `project-<projectId>` 会话识别为工作站会话，规则非空时注册 `dsh-superagent-workstation` 系统提示段（含工作站目录）；该工作站工单 worker 的提示词追加同一份要求（不含目录行）；规则为空时不注入。
- **一键会话。** 会话导航抽到 `src/navigation.ts`：`openProjectConversation(host, project, signal)` 先用 `workspaces.create({path: conversationDir})` 为工作站目录注册 / 复用本地工作区（失败或没有 workspace 服务时回退 cwd），再以确定性 id `project-<projectId>` 创建会话（已存在则 refresh 后打开，刷新仍不解释才抛原始错误），打开前再 refresh 一次让 UI 会话树列出它，最后 `uiWorkspace.openSession`。`src/client/index.tsx` 用 `ctx.get('workspaces')`、`ctx.sessions`、`ctx.uiWorkspace.openSession` 接线；按钮 busy，失败通知错误。重复点击进入同一个会话，不再出现新建会话 / 选择工作区空态，workspace 创建失败也能用 cwd 打开。
- **面板。** 工作站卡片六个分段按钮后新增「会话」；详情页头新增「打开会话」；agent 段改为「Agent 的要求与规则」编辑（逐条多行输入、`要求 N`、删除、新增要求、无改动禁用保存、内联错误、空列表提示）与「工作站会话」段（会话说明、`project-<项目 id>` 说明、打开会话按钮），历史区块保留。
- **远程文件夹不实现**（§7）：工作站地址模型没有远端类型，远程文件夹来源的投件不改变本地会话目录；远端会话（远端 workspace / 执行器 / 文件 API）的后续设计要点已记录。

### 13.2 改动文件

| 工作 | 文件 |
| --- | --- |
| 服务端 | `src/core/project.ts`、`src/app/project-service.ts`、`src/app/http.ts`、`src/app/api.ts`、`src/app/views/projects.ts`、`src/app/sessions.ts` |
| 会话导航 | `src/navigation.ts`（`ProjectConversation`、`WorkspaceController`、`ConversationHost`、`openProjectConversation`） |
| 面板 | `src/client/index.tsx`、`src/client/provider.tsx`、`src/client/project.tsx`、`src/client/app.tsx`、`src/client/locales.ts` |
| 测试 | `tests/projects.spec.ts`、`tests/resolve.spec.ts`、`tests/navigation.spec.ts`、`tests/panel-workstations.spec.tsx`、`tests/panel-panel.spec.tsx`、`tests/fixtures/panel-server.ts`、`tests/fixtures/panel.tsx` |
| 文档 | 本文件、`docs/005-panel.md`、`docs/007-architecture.md`、`plan/README.md`、`README.md`、`README.zh-CN.md` |

### 13.3 验证

- 文档验证（本次）：`npx vitest run tests/docs.spec.ts tests/class-docs.spec.ts tests/locales.spec.ts` **3 文件 / 13 项全过**（编号链接规则、007 模块表与测试表覆盖；本功能未新增 `src` 文件，模块表覆盖不变）。
- 实现相关 specs（本次复跑）：`tests/panel-workstations.spec.tsx`、`tests/navigation.spec.ts`、`tests/panel-panel.spec.tsx`、`tests/projects.spec.ts`、`tests/resolve.spec.ts` 与上述文档测试共 **8 文件 / 66 项全过**。
- 面板行为（测试覆盖）：卡片/页头两个会话入口、Workspace 创建与 cwd 回退、已存在会话不重复创建、busy 与不可恢复错误提示；agent 规则新增/编辑/删除/保存（trim、去重）、保存失败就地报错、清空即清除且不再注入。
- 全量 `pnpm check` 与桌面 profile 手工验证由 Lead 收口（数字以收口时为准）。

### 13.4 偏差与限制

- 远程文件夹 / 远程主机地址的会话未实现（§7）：工作站地址模型暂无远端类型；远程文件夹来源的投件工单按本地或受管工作站派生会话目录；真远端会话需要远端 workspace / 远端执行器与远程文件 API。
- 只有仓库地址、无本地 checkout 的仓库站仍用 `scratchDir`；checkout / worktree 由后续阶段补齐（§8）。面板创建的仓库站通常只有 `url`，因此现阶段仓库站的会话大多在副本处理目录里工作。
- 会话目录与工作站地址的映射是纯函数派生；工作站地址创建后不可修改，因此没有「地址变了会话目录要迁移」的问题。
- 工作站会话的要求段在 Agent 装饰时固定（见 §5.3）：已打开的会话不会热更新规则，重启 dsh-superagent 后重新打开才会读到新规则；工单 worker 在下一次模型请求生效。
- 与团队提示词 / Policy 冲突时，要求段只要求 agent「报告冲突而不是绕过」；它不是授权，也不改变工具权限、门禁与 Mandate。

### 13.5 提交

提交者 `shsren-saa`，提交信息按仓库规范（`feat(project): 工作站 Agent 要求与规则、一键会话`），正文列改动与验证。

## 14. 0.3.18 二次调整：删除工作站、删除会话、布局与打包约定

> 来源：用户对已上线面板的反馈（删除工作站、删除/重开工作站会话、规则编辑区布局）与发布约定调整（发布包统一放 `history/`）。服务端已落地，客户端由面板实现同阶段收口；本文以本工作区最终代码为准。

### 14.1 需求

1. **工作站可删除**：此前工作站只能归档，误建的空站也无法从注册表移除。
2. **工作站会话可删除 / 重新开始**：此前会话只能打开与复用（确定性 `project-<id>`），没有「重开一个新会话」的入口。
3. **Agent 规则编辑区布局**：底部「新增要求 / 保存」两个按钮挤在一起，需要左侧新增、右侧保存。
4. **发布包统一放 `history/`**：仓库根目录不再散放 `.tgz`。

### 14.2 删除工作站

- **数据。** `Store.projects.remove(id)` 删除一行 Project；`ProjectService.delete(id)` 只删 Project 注册行，不级联任何数据。
- **校验顺序与拒绝。**
  1. 项目不存在 → `projectUnknown`（404）。
  2. 内置 workspace → `projectFixed`（拒绝；workspace 固定不可删）。
  3. 仍有工单或产物 → `projectHasWork`，参数带项目名、工单数与产物数（面板按 `userError.projectHasWork` 显示数量）。
- **为什么拒绝仍有工单/产物的工作站。** 工单行与产物行都记录 `project_id`，而删除不级联；删掉注册行会让历史行指向不存在的项目（卡片、统计、产物反查处处不一致）。因此只允许删除**从未产生过工单或产物**的工作站；有历史的工作站保留。
- **「归档」不等于可删。** `projectHasWork` 统计全部工单与产物（含已结束工单、归档项目下的行）——归档只是隐藏，不改变计数，也无法解锁删除；当前也没有清理工单/产物的 API。产品文案里的「先归档或清理」是处理方向；实际能删的是空站。此项作为已知限制记录（后续可考虑级联删除，或只把未结束/未清理的工单计入阻止条件）。
- **路由。** `DELETE projects/:id` → `{ deleted: true }`；Host 校验同上。
- **面板。**
  - 工作站卡片右上角新增删除按钮（trash 图标），**仅非内置 workspace 显示**；点击弹确认（ConfirmButton），确认后调用删除，成功刷新卡片列表。
  - 工作站详情页头也提供删除入口（非 workspace）；删除成功后返回工作站列表。
  - 被拒绝时弹出本地化错误提示（toast，`userError.projectHasWork` 含工单/产物数量），确认框保持打开、工作站与页面状态不变。
- **会话处理。** 删除成功后，客户端尽力把该工作站的会话（按删除前的 generation 计算 id）交给 `uiWorkspace.archiveSession(id, { stopActivity: true })` 归档；归档失败忽略（工作站已删，不影响结果）。删除不删除 DSH 里的会话本体，它留在 DSH 归档中。
- **已知边界。** 删除后以同一名称重建工作站会得到同一个 `prj_<key>` id 且 `conversationGeneration` 重新从 0 开始，会话 id 会和旧归档会话同名；Host 拒绝创建且刷新后的目录仍不列出该归档会话时，面板会报创建失败。可换一个名称，或后续在重建时让会话代数从归档里已有 id 之后开始。
- **不影响历史数据。** 有历史的工作站被拒绝删除，其工单、产物、历史全部保留；能删除的工作站本来就没有历史数据。

### 14.3 删除会话（重新开始工作站会话）

- **数据。** `ProjectValue.conversationGeneration?: number`（缺省 0）。`projectSessionId(projectId, generation = 0)`：第 0 代为 `project-<id>`，之后为 `project-<id>-<generation>`；`projectIdOfSession(sessionId)` 去掉末尾的 `-<数字>` 仍解析回项目 id，所以旧会话也能识别为「该项目的工作站会话」。
- **服务。** `ProjectService.resetConversation(id)`：代数 +1 并保存，返回更新后的 `ProjectRecord`；没有会话也可重置（只是让下一次打开用新 id）。
- **路由。** `POST projects/:id/conversation/reset` → `{ project }`。
- **面板。** agent 段「工作站会话」内、「打开会话」旁新增「删除会话」按钮（确认框）；确认后：
  1. `POST projects/:id/conversation/reset`，代数 +1；
  2. 尽力归档旧会话：`uiWorkspace.archiveSession(projectSessionId(id, 旧代数), { stopActivity: true })`，失败忽略（旧会话留在 DSH）；
  3. 重新读取工作站详情（generation 已变化）并 notify；
  4. 下一次「打开会话」按新 generation 创建 `project-<id>-<n>` 新会话。
- **行为。** 旧会话**不删除**，留在 DSH 归档中可查；同一 id 不再复用；新会话是普通 DSH 会话，再次注入当前的 Agent 要求与规则段——所以「删除会话」也是让规则改动进入新会话、无需重启 dsh-superagent 的途径。
- **入口传参。** 卡片与页头的「打开会话」都要传 `conversationGeneration`（卡片取 `project.conversationGeneration`，详情取 `data.conversationGeneration`）；漏传会打开旧代 id。
- **视图。** `ProjectRowView.conversationGeneration` 与 `GET projects/:id` 顶层 `conversationGeneration` 暴露当前代数。

### 14.4 Agent 规则编辑区布局

- 底部操作行改为：左侧「新增要求」（outline），右侧「保存」（primary）；保存仅在 dirty 时可用（原有语义不变：trim、去重、空数组清除）。
- 空态提示、规则列表与操作行之间整理间距，两个按钮不再挤在一起。
- 不改变规则的数据模型、接口与生效时机（见 §5.3 与 §13.4）。

### 14.5 发布包统一放 history/

- **约定。** 所有已发布构建包 `dsh-superagent-<version>.tgz` 统一放在 `history/` 下并随 git 跟踪，仓库根目录不再存放 `.tgz`；包文件不覆盖、不删除。
- **同步。** `releases/README.md` 的「包路径」列与 `releases/manifest.json` 的 `tgz` 字段一律写 `history/dsh-superagent-<version>.tgz`；`releases/` 只保留索引与说明。此前放在根目录的 0.3.17 包与本次 0.3.18 包都在本次发布中归入 `history/`。
- **流程。** 发版时用 `pnpm pack --pack-destination history` 直接在 `history/` 产出包，或打包后移入 `history/`，并登记 `releases/README.md` 与 `manifest.json`。打包与 `releases/**` 的维护由发布流程（Lead）执行，本文件只记录约定。

### 14.6 验证与限制（0.3.18）

- 服务端单测：`tests/projects.spec.ts`（两代会话 id 的命名与反解）、`tests/resolve.spec.ts`（`resetConversation` 递增；`delete` 删除空站，拒绝内置 workspace 与未知项目）。`projectHasWork` 的拒绝由服务层与面板 fixture 覆盖；HTTP 路由层未单独加用例。
- 客户端测试：`tests/panel-workstations.spec.tsx` 覆盖卡片/详情删除入口与确认、删除成功刷新与失败提示（toast 含数量、确认框保持打开）、删除会话（POST reset + 归档旧会话 + 新代数打开新会话 id）、规则编辑区「左新增 / 右保存且仅 dirty 可用」；`tests/navigation.spec.ts` 覆盖代数命名与旧会话归档 best effort。
- 本次复核：`tests/docs.spec.ts`、`tests/class-docs.spec.ts`、`tests/locales.spec.ts`、`tests/projects.spec.ts`、`tests/resolve.spec.ts`、`tests/navigation.spec.ts`、`tests/panel-workstations.spec.tsx`、`tests/panel-panel.spec.tsx` 共 **8 文件 / 74 项全过**。
- 全量 `pnpm check` 与桌面 profile 手工验证由 Lead 收口，测试总数以收口时为准。
- 已知限制：只有「从未产生工单/产物」的工作站可删除；同名重建的会话 id 可能与旧归档会话同名（见 §14.2）；发布包移动是发布流程的手工步骤，不在代码中自动完成。


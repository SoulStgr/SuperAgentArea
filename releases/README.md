# Releases — SuperAgentArea（saa）

本目录归档**每个已发布的构建包**，用于回退、复现或在某个版本上继续开发。包文件（`dsh-superagent-<version>.tgz`）统一保存在 `history/` 目录并随 git 跟踪，**不删除**；仓库根目录不再放包。

每个版本记录：包文件名、大小、SHA-256、源提交（git 仓库哈希）、功能主题、与上一版的对比。

> 约定：新增版本时必须同时更新本文件与 `manifest.json`；包文件不可覆盖（新版本用新文件名）。

---

## 1. 版本索引

| 版本 | 打包日期 | 包路径 | 大小 | SHA-256（前 16 位） | 源提交 | 主题 |
|---|---|---|---|---|---|---|
| 0.1.0 | 2026-11-24 | `history/dsh-superagent-0.1.0.tgz` | 315,209 | `9c9ccf8fed52f103` | `73dfd0f`（压平，见注） | 本地文件夹源 + 产物交付（阶段 1） |
| 0.1.1 | 2026-11-24 | `history/dsh-superagent-0.1.1.tgz` | 315,294 | `ab7a52ffbc7e2e29` | 同上（压平） | DSH 0.2.2 subagent seam 适配、停止失败诊断 |
| 0.1.2 | 2026-11-24 | `history/dsh-superagent-0.1.2.tgz` | 315,661 | `8d574b6de76d7c11` | 同上（压平） | 中文编码修复（文本投件进 Trigger） |
| 0.1.3 | 2026-11-24 | `history/dsh-superagent-0.1.3.tgz` | 315,739 | `805bd66519f3d2bd` | 同上（压平） | GitHub 部署可选（无 gh 也能安装） |
| 0.1.4 | 2026-11-25 | `history/dsh-superagent-0.1.4.tgz` | 315,875 | `9ced85badce056a0` | `e69bdfe` | 正式命名 SuperAgentArea（面板/侧栏） |
| 0.1.5 | 2026-11-25 | `history/dsh-superagent-0.1.5.tgz` | 315,995 | `f564b7edcc45be4e` | `e69bdfe` | DSH 插件列表标题/描述更名 |
| 0.2.0 | 2026-11-25 | `history/dsh-superagent-0.2.0.tgz` | 367,302 | `99796d69c8410faf` | `70a42be` | P1–P4：schema 12、多实例、项目归属、工单源页、工作站页 |
| 0.2.1 | 2026-11-25 | `history/dsh-superagent-0.2.1.tgz` | 375,550 | `0923795f5b18ba41` | `82554a5` | P5：产物页、下载、产物→worker 反查 |
| 0.2.2 | 2026-11-25 | `history/dsh-superagent-0.2.2.tgz` | 378,207 | `e99d98690c626c7a` | `f52b079` | P6a：项目历史、项目会话、agent 段 |
| 0.2.3 | 2026-11-25 | `history/dsh-superagent-0.2.3.tgz` | 378,443 | `79e4171feca80832` | `90d8f6f` | P6b：六 Tab、提示词/策略一级、设置齿轮 |
| 0.3.0 | 2026-11-25 | `history/dsh-superagent-0.3.0.tgz` | 379,980 | `a95e65ad803f9407` | `ef8f4b4` | P6c：实例级健康、具名 Setup 校验、KV 清理（P1–P6 完成） |
| 0.3.2 | 2026-11-26 | `history/dsh-superagent-0.3.2.tgz` | 396,272 | `f5a6b73103ab8688` | `62ff18a`（等价树 `f25ce6a`） | 每源提示词/策略下沉、默认技能按 kind、治理页、四 Tab |
| 0.3.3 | 2026-11-26 | `history/dsh-superagent-0.3.3.tgz` | 405,377 | `ebb700f316810dbc` | `85622d7`（构建）+ `0fb3f7b`（入库） | P7：设置 Tab、工单源设置页（10 类来源/多账号）、两步添加来源、默认本地文件夹、删除来源 |
| 0.3.4 | 2026-11-26 | `history/dsh-superagent-0.3.4.tgz` | 405,422 | `93d1302fb0209115` | `0fb3f7b` | 飞书列为常驻来源项（账号按需添加） |
| 0.3.5 | 2026-11-26 | `history/dsh-superagent-0.3.5.tgz` | 405,998 | `dc6a22e17f6ddea3` | `255d98c` | 添加来源类型改为四列 flex 卡片（宽弹窗、紧凑卡片） |
| 0.3.6 | 2026-11-26 | `history/dsh-superagent-0.3.6.tgz` | 418,625 | `ec5f999ce09976e8` | `8c7108f` | 远程文件夹（SFTP/SSH，仅密钥 + known_hosts 强校验）、11 类来源顺序 |
| 0.3.7 | 2026-11-26 | `history/dsh-superagent-0.3.7.tgz` | 435,560 | `efcc3b0a7f7ba01b` | `1c6d61c` | 钉钉 Stream 来源（真实收发、token/@、每实例健康；不依赖 dsh-im） |
| 0.3.8 | 2026-11-26 | `history/dsh-superagent-0.3.8.tgz` | 451,819 | `135773948bf91092` | `9450a36` | QQ 机器人网关来源（私聊/群 @、被动回复、健康） |
| 0.3.9 | 2026-11-26 | `history/dsh-superagent-0.3.9.tgz` | 469,236 | `d4af66c82d52d1eb` | `047437c` | 微信 iLink 来源（扫码登录、白名单私聊、token 本地存储） |
| 0.3.10 | 2026-11-26 | `history/dsh-superagent-0.3.10.tgz` | 474,980 | `7b270de4db7e7848` | `c292ecd` | 钉钉入站图片/文件附件（下载落盘、随 Trigger 交给 Worker） |
| 0.3.11 | 2026-11-26 | `history/dsh-superagent-0.3.11.tgz` | 480,502 | `38983fece03ed7ff` | `cc48e6f` | QQ 入站图片/文件附件（主机白名单、限额、落盘） |
| 0.3.12 | 2026-11-26 | `history/dsh-superagent-0.3.12.tgz` | 487,824 | `fbd0ffae136ad8bd` | `a6455b6` | 微信入站图片/文件附件（CDN + AES 解密、落盘） |
| 0.3.13 | 2026-11-26 | `history/dsh-superagent-0.3.13.tgz` | 491,481 | `e079dfa9a13e1bed` | `b29abae` | 钉钉出站产物附件（工单产物回传为文件/图片） |
| 0.3.14 | 2026-11-26 | `history/dsh-superagent-0.3.14.tgz` | 510,789 | `3c8dfddb28ba8d2c` | `125103c` | 网页/地址来源（RSS/Atom/JSON）、钉钉扫码接入、微信二维码修复、QQ 双 Tab |
| 0.3.15 | 2026-11-26 | `history/dsh-superagent-0.3.15.tgz` | 514,490 | `96f5bcb100fd12ac` | `2da92fe` | QQ 扫码接入（自实现绑定协议，不依赖 UNLICENSED 组件） |
| 0.3.16 | 2026-11-26 | `history/dsh-superagent-0.3.16.tgz` | 516,181 | `16aa69f1f7c94443` | `8d74543` | 配置历史密钥脱敏、账号显示名称可改且全安装唯一 |
| 0.3.17 | 2026-11-26 | `history/dsh-superagent-0.3.17.tgz` | 519,406 | `cc50e66eee549cb0` | `4c819a9` | 工作站 Agent 要求与规则、一键会话（不选工作区） |
| 0.3.18 | 2026-11-26 | `history/dsh-superagent-0.3.18.tgz` | 521,832 | `d03d4434ac195bcf` | `0057b6f` | 删除工作站、删除会话（会话代数）、规则编辑布局、发布包统一入 history |
| 0.3.19 | 2026-11-26 | `history/dsh-superagent-0.3.19.tgz` | 522,459 | `12f902101815a207` | `7fd5d8d` | 会话直达（Workspace 预建/命名 SAA-工作站名、不再选工作区）、agent 段精简 |
| 0.3.20 | 2026-11-26 | `history/dsh-superagent-0.3.20.tgz` | 521,499 | `be07ea133079e9c0` | `9b04b4b` | agent 段再精简（移除工单/产物/报告历史，只保留要求与规则） |
| 0.3.21 | 2026-11-27 | `history/dsh-superagent-0.3.21.tgz` | 522,006 | `aef73cf8e6c9529d` | `ee5ccd4` | 钉钉扫码接入接受 CREATING/PUBLISHING/APPROVING 等中间状态，凭据齐全即建号 |

> **关于 0.1.0–0.1.3 的源提交**：本仓库历史被压平过一次（`73dfd0f Initialize`），这四个包是在压平前构建的，原始提交哈希已不可回溯；包文件与其校验和可用于回退，但无法从当前仓库重建出逐字节相同的源码树。
>
> **关于 0.3.3 的源**：包由 P7b 完成时的源码树（`85622d7`）构建、版本号改为 0.3.3；因未单独提交版本号变更，包随 `0fb3f7b` 入库。若要重建等效源码，用 `85622d7` 并手动改 `package.json` 版本为 0.3.3。
>
> **0.3.1**：其他会话的中间构建，已被 0.3.2 取代，仓库不保留。

## 2. 各版本功能与对比

### 0.1.x（早期迭代）

- 0.1.0：首个可安装包。本地文件夹源（投件→Trigger→建单→Worker→`deliver/`→outbox 回执）、Windows 基线适配。
- 0.1.1：适配 DSH 0.2.2 的 subagent seam（`drainDescendants`/`waitForTreeWork`），worker 停止失败带原因，文本投件内容进 Trigger。
- 0.1.2：修复中文经 shell 读取的乱码路径；同名产物冲突短 id 后缀。
- 0.1.3：GitHub 部署可选（无 gh CLI/仓库也能启动，folder-only 可用）。
- 0.1.4/0.1.5：正式命名 SuperAgentArea（面板、侧栏、DSH 插件列表）。

对比：0.1.x 是"单文件夹源 + 产物交付"的最小闭环，没有项目组、多实例或设置体系。

### 0.2.0

- schema 12：`project`/`artifact` 表、ticket `projectId/sourceId`、`area/` 目录（workspace/`<station>.work`）。
- 多实例来源（`<kind>:<key>`）、项目归属前置（`PROJECT.md`/`[项目]`/会话标题/注册表匹配、`needsProject` 提问+重评、提案+人确认、汇报人/@提及）。
- 新面板：工单源（实例卡/统计/添加来源/未归属回答）、工作站（卡片/六段/新建归档）。

对比 0.1.x：从"一个文件夹源"升级为多来源 + 项目组 + 产物索引；旧数据自动迁移（v11→v12）。

### 0.2.1

- 产物一级页：列表/过滤/下载；产物详情反查 `Artifact → Ticket → Assignment → worker-<ticketId>`；工单/项目/概览的产物入口。

对比 0.2.0：产物从"落盘+回复"变成可浏览、可下载、可追溯。

### 0.2.2

- 项目历史 API（工单/产物/报告）与 agent 段；项目会话 `project-<id>` 懒创建（cwd=项目 scratchDir）。

对比 0.2.1：工作站 agent 段从占位变为可用。

### 0.2.3

- 六 Tab：概览/工单源/工作站/产物/提示词/策略；设置改 header 齿轮；提示词与策略一级页；workspace 计数含旧数据。

对比 0.2.2：信息架构收口，配置从主 Tab 退到设置。

### 0.3.0

- 实例级健康条目；具名 GitHub/Feishu 实例的轻量 Setup 校验（非阻塞、实例问题）；停止写 `KV.artifacts`。

对比 0.2.3：多实例的运行态可见性与收口完成；P1–P6 里程碑结束。

### 0.3.2

- 提示词与策略下沉到来源实例（缺省继承安装默认，标注 inherited）；默认技能按 kind 自动扫描（github/feishu/folder，新增 folder 技能）；独立「策略提示配置」页（策略/提示词两 Tab）；一级 Tab 收敛为概览/工单源/工作站/产物，设置三组；旧路由重定向；README 中英双版本、融合架构文档归档到 `plan/`。

对比 0.3.0：多来源从"共享安装级提示词/策略"变为"每源独立"，新增来源即可拥有自己的治理配置。

### 0.3.3

- 默认只播种一个本地文件夹来源（`area/local/inbox|outbox`），registry 不再合成默认实例（GitHub 不再默认出现）。
- 设置 Tab + 工单源类别：10 类来源项（folder/github/feishu + gitee/wechat/dingtalk/qq/telegram/wecom/email 占位），多账号增删改启停；添加来源两步（选类型→已有账号或新建）；`DELETE /sources/:id`（有未结束工单 409）。

对比 0.3.2：来源管理从"平铺卡片"升级为"设置里的来源项 + 多账号"，默认体验改为本地文件夹优先。

### 0.3.4

- 飞书 kind 常驻来源项目录（`feishu-watch` 默认启用）：账号按需添加，无账号时不轮询、overview 无噪音。

对比 0.3.3：补齐"飞书"来源项缺口，10 类来源项完整。

### 0.3.5

- 「添加来源」第一步的类型选择由单列长条改为**四列 flex 网格**（弹窗加宽到 900px，窄屏降为两列/一列）。
- 类型卡片压缩：标题行（图标 + 名称 + 占位标签）、两行描述、账号数底部对齐；账号/编辑弹窗加宽到 560px。

对比 0.3.4：纯界面优化，无接口与数据变化；来源项、账号与既有数据完全兼容。

### 0.3.6

- 新增 **远程文件夹（`remote`）**：通过 SFTP 轮询远端 inbox、投件建单、回执写入 outbox、处理后移入 `.done`。
- 安全：仅密钥认证、`StrictHostKeyChecking=yes` + 指定 known_hosts（可选指纹钉死）、`sftp -b -` 不走 shell、路径白名单、单文件/轮次限额与超时、日志不含私钥。
- 来源项顺序按图 1 固定为 11 类：本地文件夹、远程文件夹、QQ、钉钉、微信、企业微信应用、邮箱、飞书、GitHub、Gitee、Telegram；catalog 增加 `order`。
- 方案：IM 三家改为**移植 dsh-im 传输层**（MIT 署名、不引入运行时依赖）；微信先白名单私聊。

对比 0.3.5：从「只有本地文件夹可用」变为「本地 + 远程文件夹可用」，并为后续钉钉/QQ/微信移植定下架构。

### 0.3.7

- **钉钉来源真实可用**：`dingtalk` kind（order 4）通过公共 SDK `dingtalk-stream` 长连接接收私聊与群 @ 消息，回复走 sessionWebhook（带原生 @）或机器人 API 兜底；token 缓存/提前刷新；每实例独立健康与 5s→60s 重连；`allowedUserIds` 白名单；secret 不进日志/健康/Trigger。
- 复用 dsh-im 的协议细节（MIT 署名，`THIRD_PARTY_NOTICES.md`），但**不引入 `@xmanrui/dsh-im` 运行时依赖**；AI Card/文件/图片留到后续。
- 顺带修复 `package.json` 的 UTF-8 BOM（由 PowerShell 写入引入），避免 `packageRoot()` 的 JSON 解析失败。

对比 0.3.6：11 类来源中钉钉从占位变为可用；QQ、微信仍为占位（P8c/P8d）。

### 0.3.8

- **QQ 来源真实可用**：`qq` kind（order 3）通过公共 SDK `@tencent-connect/qqbot-nodejs` 连接 QQ 机器人网关；私聊与群 @ 消息触发工单；回复走被动 `msg_id`（稳定 `msg_seq` 去重）、markdown 优先并回退纯文本、群回复带 `<@openid>`；窗口过期返回 `gone`，不转主动消息。
- 每实例独立健康（连接阶段、消息/跳过/失败计数、重连 5s→60s）；`appId/appSecret/allowedUserIds/sandbox` 配置；secret 脱敏。
- 复用 dsh-im 的 QQ 协议细节（MIT 署名），不引入 dsh-im 依赖；未采用 `@tencent-connect/qqbot-connector`（其许可证为 UNLICENSED，且凭据由本仓库保存）。

对比 0.3.7：11 类来源中钉钉、QQ 均可用；微信仍占位（P8d）。

### 0.3.9

- **微信来源可用**：`wechat` kind（order 5）通过 iLink 协议扫码登录，只接收**白名单私聊**文本并原会话回复；群消息一律忽略（P8e 再开）。
- 扫码：面板「扫码登录」弹窗显示二维码并轮询；`confirmed` 后 token 存本地 KV（不入 settings、不回传客户端）；登录失效提示重新扫码。
- 收发：长轮询 `getupdates`（游标/去重 KV，7 天）、`sendmessage` 按 1800 字切分；每实例健康；token 不进日志/health/Trigger。
- 协议层从 dsh-im 移植（MIT 署名），不引入 dsh-im 依赖；新增公共依赖 `qrcode` 用于渲染二维码。

对比 0.3.8：本地文件夹、远程文件夹、QQ、钉钉、微信五类可用；企业微信应用、邮箱、Gitee、Telegram 仍为占位。

### 0.3.10

- **钉钉入站图片/文件**：识别 `picture`/`file`/`richtext` 附件，经 `robot/messageFiles/download` 取受信 HTTPS 下载地址，落盘到 `<stateDir>/area/attachments/dingtalk/<instance>/<messageId>/`；Trigger 文本附绝对路径，`meta.attachments` 带 kind/mime/bytes，Worker 可直接读取。
- 限额 20 MiB/文件、5 个/消息；非法/失败/超限只记健康计数、不建空单；文件名白名单与路径校验防穿越；下载不跟随任意重定向。
- 出站附件仍只文本；QQ/微信附件为后续。

对比 0.3.9：钉钉从纯文本收发升级为文本 + 入站图片/文件。

### 0.3.11

- **QQ 入站图片/文件**：识别 `attachments[]`（`url/filename/content_type/size`），下载到 `<stateDir>/area/attachments/qq/<instance>/<messageId>/`；Trigger 文本附绝对路径、`meta.attachments` 带 kind/mime/bytes。
- 仅允许 https + 六个腾讯 CDN 主机后缀；不跟随重定向、30s 超时、20 MiB/文件、5 个/消息；失败/超限只记健康，不建空单；签名 URL 不进 Trigger/健康。
- 出站仍只文本；微信附件为下一步。

对比 0.3.10：钉钉与 QQ 均支持入站图片/文件；微信仍只文本。

### 0.3.12

- **微信入站图片/文件**：iLink `item_list.image_item/file_item` → 受信 CDN（`novac2c.cdn.weixin.qq.com/c2c`）下载、AES-128-ECB 解密，落盘 `<stateDir>/area/attachments/wechat/<instance>/<messageId>/`；Trigger 带绝对路径与 `meta.attachments`。
- 限额 20 MiB/文件、5 个/消息；URL/密钥/查询串不进日志/健康/Trigger；失败/超限只记健康、不建空单。
- 三渠道（钉钉/QQ/微信）入站附件齐备；出站附件仍只文本；技能描述同步更新。

对比 0.3.11：微信从纯文本升级为文本 + 入站图片/文件；出站附件与微信群回复为后续（群回复受 iLink 限制不可用）。

### 0.3.13

- **钉钉出站产物附件**：工单 `ready` 的产物（`deliver/`）随结果回复一起回传为钉钉文件/图片；文本先发，附件后发；上限 10 个/20 MiB；单个附件失败只计数、不影响文本送达。
- 核心链路：`OutboundMessage.attachments`（内部绝对路径，不写日志/Trigger）→ `ReplyRequest.result` → `deliverArtifacts` 把产物名/路径/MIME/大小带入结果回复；旧收据兼容。
- 其他渠道暂忽略附件（保持文本）；QQ/微信出站附件为后续。

对比 0.3.12：钉钉成为双向附件（入站图片/文件 + 出站工单产物）；微信/QQ 仍只在入站方向支持附件。

### 0.3.14

- **网页/地址来源**（`web`，排序 3）：监听公开 RSS/Atom/JSON 地址，新条目生成工单；首轮默认只记基线、KV 去重；SSRF 防护、20s 超时、2 MiB 上限；只读、不回帖。
- **钉钉扫码接入**：添加账号弹窗分「扫码接入 / 手工接入」；扫码走钉钉设备注册流程，成功后服务端自动创建账号（Client ID/Secret，RobotCode 用 AppKey 回退），secret 不回传浏览器。
- **微信二维码修复**：服务端拉取 iLink 图片并转 data URL；不是图片时把内容本地渲染成二维码，避免把落地页当图片加载。
- **QQ 双 Tab**：扫码接入标记「开发中」（腾讯组件 UNLICENSED），手工接入保留；钉钉/QQ 手工接入增加创建机器人链接与步骤。
- 使用说明更新：`use/IM接入说明.md`、`use/网页地址监听.md`、`use/远程文件夹配置.md`（通俗步骤版，仍仅密钥）。

对比 0.3.13：来源从 11 类增至 12 类（新增 web）；账号接入从纯手工升级为钉钉扫码 + 双 Tab，微信二维码可用。

### 0.3.15

- **QQ 扫码接入可用**：按腾讯公开的绑定协议自行实现（`create_bind_task` → 二维码 → `poll_bind_result` → AES-256-GCM 解密 `bot_encrypt_secret`），**未引入** UNLICENSED 的 `qqbot-connector`。
- 面板「扫码接入」Tab 启用：二维码 + 2 秒轮询 + 过期刷新；成功后服务端自动建号（key `qq`、label「QQ（扫码）」、扫码人 openid 自动加入白名单），AppSecret 不回传浏览器。
- 手册接入保留，链接 QQ 开放平台。

对比 0.3.14：钉钉、QQ 均支持扫码创建；两者相加覆盖了三个 IM 中除微信（个人号扫码登录）外的扫码入口。

### 0.3.16

- **配置历史不再泄露 AppSecret**：`settings-history.ts` 对凭据字段只输出「已设置 / 已更换 / 已清空」，`from`/`to` 不带值；`GET policy/history` 的 JSON 与面板「配置历史」都不再出现密钥内容。新增共享判定 `src/secret.ts`，面板密码框、账号摘要与历史文案使用同一规则。
- **显示名称可改且唯一**：编辑配置卡片顶部新增可编辑的显示名称，随 `source:<id>` 块一起保存；服务端按去空格、忽略大小写做全安装唯一校验，重复时返回 `sourceLabelExists` 并提示占用名称的账号；扫码建号自动取编号名称（如「QQ（扫码）2」），不会与已有名称冲突。
- 测试：`pnpm check` 全绿，1575 passed / 14 skipped；新增凭据历史脱敏、名称唯一与改名用例。

对比 0.3.15：修复「配置历史把 AppSecret 明文显示出来」的安全风险；账号显示名称从只读变为可编辑，并保证全安装内不重名。

### 0.3.17

- **工作站 Agent 的要求与规则**：每个工作站可记录操作者给定的人设或强制方向（`ProjectValue.agentRules: string[]`，1–2000 字/条、最多 50 条、trim+去重、空数组清除，无 schema 迁移）。工作站页 agent 段改为逐条增删改编辑器，空列表不显示内容；规则注入该工作站会话的系统提示段与它工单 worker 的提示词，空列表不注入。
- **一键会话**：工作站卡片新增「会话」入口、页头新增「打开会话」，点击直接进入确定性 `project-<projectId>` 会话，不再出现「新建会话/选择工作区」空态，也不会每次新建会话；会话目录按工作站地址取——本地文件夹用其路径、代码仓库有本地 checkout 用该路径、其余用副本处理目录。实现为 `openProjectConversation`：创建/复用该目录的 DSH Workspace → 以 `workspaceId` 创建会话（失败回落 cwd）→ 刷新目录 → 在 DSH 对话界面打开该会话。
- **远程文件夹会话**：本次只写设计（`plan/23-工作站Agent与对话.md` §7），暂不实现；需要工作站地址支持远端类型、远端 workspace/执行器挂载与远端文件 API，失败时回退副本处理目录。
- 面板文案中英文同步；新增/更新 `projects`、`resolve`、`navigation`、`panel-workstations` 等用例；`pnpm check` 全绿（1580 passed / 14 skipped）。

对比 0.3.16：工作站从「项目会话入口 + 历史」升级为「Agent 要求与规则 + 一键会话」；会话不再要求选择工作区，且会话目录跟随工作站真实地址。

### 0.3.18

- **删除工作站**：新增 `DELETE projects/:id`。内置 workspace 固定不可删；仍有工单或产物的项目拒绝并返回数量（先归档/清理；归档不会清空计数），实际只能删除从未产生工单/产物的空站。卡片右上角与详情页头新增删除入口，成功后尽力归档其会话并刷新列表/返回工作站页。
- **删除会话**：工作站记录 `conversationGeneration`，会话 id 为 `project-<id>`（第 0 代）与 `project-<id>-<n>`；agent 段「工作站会话」新增「删除会话」，重置代数并尽力把旧会话归档到 DSH 归档区，下次打开自动创建新一代会话（也让新改的 Agent 规则进入会话，无需重启）。
- **Agent 规则编辑布局**：底部操作行左「新增要求」、右「保存」（仅改动可用），间距整理。
- **发布包统一入 history/**：所有 `dsh-superagent-<version>.tgz`（含 0.3.17、0.3.18）都归档在 `history/`，仓库根不再放包；发版流程改为 `pnpm pack --pack-destination history`，manifest 与本文件路径同步；桌面 profile 依赖也从 `history/` 安装。
- 测试：`pnpm check` 全绿（77 个测试文件 / 1602 项：1588 passed / 14 skipped + build）；新增删除工作站、删除会话、代数命名与布局用例。

对比 0.3.17：工作站获得删除与「删除会话」生命周期操作；Agent 规则编辑更整洁；发布包不再放仓库根。

### 0.3.19

- **会话直达**：工作站会话点击后，先创建/复用工作站目录的 DSH Workspace 并命名为 `SAA-<工作站名称>`，再创建/采纳确定性 `project-<id>` 会话，随后 `workspaces.rename(...)` 用 host 返回的 Workspace 行（带 `sessionIds`）刷新客户端快照——DSH 对话直接显示该 Workspace、不再出现「选择一个工作区开始」。
- **旧会话迁移**：若刷新后 Workspace 行仍不含该会话（旧版本遗留、无法在客户端补挂），自动 `POST projects/:id/conversation/reset` 代数 +1，以 `project-<id>-<n>` 新建并再次命名 Workspace；旧会话保留在 DSH、内容不迁移。
- **agent 段精简**：移除整块「工作站会话」（打开/删除会话），agent 段只保留 Agent 要求与规则 + 工单/产物/报告历史；「打开会话」只保留在工作站卡片与详情页头，「删除会话」移到详情页头与打开并列。
- 面板与测试：新增/更新 navigation 与 panel-workstations 用例（rename 标题、sessionIds 刷新、rename 失败回落、stale 会话 reset、无 Workspace 回退、agent 段精简）。
- 测试：`pnpm check` 全绿（77 个测试文件 / 1605 项：1591 passed / 14 skipped + build）。

对比 0.3.18：修复工作站会话仍要求选择工作区的问题（本地 Workspace 快照未含新会话）；agent 段不再放会话入口；Workspace 统一以 `SAA-<工作站名称>` 命名。

### 0.3.20

- **agent 段再精简**：移除工作站的「工单历史 / 修改历史（产物）/ 最近报告」三块历史展示，agent 段只保留「Agent 的要求与规则」；历史内容仍在各自页面：工单 → 执行页，产物 → 产物页，报告 → Ticket/Assignment 详情。
- 同步清理面板中不再使用的历史行组件、`GET projects/:id/history` 轮询、`LoadState` 与相关 CSS；服务端 `GET projects/:id/history` 路由与 `projectHistory` 视图**保留**（面板不再调用）。
- 测试：更新 panel-workstations（agent 段只断言规则、无工作历史、无工单工作站仍可打开会话）；`pnpm check` 全绿（77 个测试文件 / 1603 项：1589 passed / 14 skipped + build）。

对比 0.3.19：agent 段从「要求与规则 + 历史」精简为「要求与规则」，更聚焦该功能；历史不丢失、只是回到各自归属页面。

### 0.3.21

- **钉钉扫码接入修复**：DingTalk 的设备注册在 `WAITING` 之后还会经过 `CREATING`、`PUBLISHING`，企业开启「应用审批」时还会停在 `APPROVING`；`APPROVING` 阶段凭据（`client_id` / `client_secret`）已经发放。旧实现只认 `SUCCESS`，遇到这些状态直接报 `DingTalk reported an unknown sign-in state` 并失败，于是手机上已选完机器人、面板却显示失败。
- 现在由 `DingtalkDeviceAuth.poll` 归一化 7 个已知状态，并且**只要两个凭据都返回就携带**；`DingtalkLoginManager` 以凭据齐全判定成功，`WAITING/CREATING/PUBLISHING/APPROVING`、未知状态、以及只返回一半凭据的情况都继续轮询到 TTL，`FAIL`/`EXPIRED` 仍立即终止。企业待审批时账号会先创建，管理员通过后机器人才连上（面板扫码说明已补充）。
- 测试：中间状态、`APPROVING` + 凭据、未知状态继续等待、半凭据继续等待；`pnpm check` 全绿（77 个测试文件 / 1604 项：1590 passed / 14 skipped + build）。

对比 0.3.20：修复钉钉扫码接入在真实设备注册中间态（尤其 `APPROVING`）下误判失败的问题；扫码后能正常创建并启用账号。

## 3. 回退与复现

### 3.1 安装某个已归档的包

```powershell
Copy-Item .\history\dsh-superagent-0.3.2.tgz "$env:USERPROFILE\.dsh\profiles\desktop\vendor\"
# 然后用 DSH 的 plugin_manager 安装：
# plugin_manager install_bundle file:vendor/dsh-superagent-0.3.2.tgz
```

校验包完整性：

```powershell
Get-FileHash .\history\dsh-superagent-0.3.2.tgz -Algorithm SHA256
# 与 manifest.json / 上表比对
```

### 3.2 在某个版本上重新开发

```powershell
cd H:\DTB_AIToos\superAgent\dsh-superagent-fusion
git worktree add ..\saa-at-0.2.3 90d8f6f   # 换成目标版本的源提交
cd ..\saa-at-0.2.3
pnpm install
pnpm check
pnpm pack --pack-destination history        # 产出 history/dsh-superagent-<version>.tgz
```

- 0.1.x 无法用当前历史重建（见上），只能用归档 tgz 回退。
- 0.3.2 的等效源码树是 `f25ce6a`（合并修复后的树，功能与 `62ff18a` 相同）。
- 新开发请基于 `main` 最新或目标版本的 worktree，避免直接改归档包。

### 3.3 状态目录兼容性（重要）

- **0.2.0 及之后**：数据库 schema 12；settings/项目/产物结构一致，可互相升级/回退（回退前备份）。
- **0.1.x**：schema 11；若当前库已迁移到 12，**不能直接降级**（会报 "Unsupported orchestrator database version"）。回退到 0.1.x 需要：
  1. 使用该版本对应的旧 stateDir 备份，或
  2. 在 profile 里把 `stateDir` 指向一个全新的空目录（会创建一个新的 workspace 项目，历史不可见）。
- 每次升级/回退前建议做一致性备份：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('C:/Users/21973/.dsh/state/superagent-desktop/orchestrator.sqlite');db.exec(\"VACUUM INTO 'C:/Users/21973/.dsh/state/superagent-desktop-backup-<version>-<time>.sqlite'\");db.close()"
```

## 4. 版本号约定

- **0.x.y**：`x` 为架构/里程碑阶段（P1–P6 为 0.2.x/0.3.0；P7 为 0.3.3+），`y` 为阶段内构建或修复。
- 每次发版：`pnpm check` 全绿 → `pnpm pack --pack-destination history` → 更新本文件与 `manifest.json` → 提交（包统一放 `history/`，仓库根不再放包）。
- 包文件不覆盖、不删除；`manifest.json` 是机器可读索引。

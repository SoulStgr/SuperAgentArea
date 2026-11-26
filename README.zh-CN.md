# SuperAgentArea（saa）

[English](README.md) · **简体中文**

> **SuperAgentArea（saa）** 是本分支的工作名。bundle 包名、插件 id 与状态目录仍沿用上游的 `dsh-superagent` 命名，保证已装实例继续可用；包级更名计划随界面大改一起发布。

> **仅供研究参考的原型，不是 DeepSeek 官方产品。** 这份代码源自团队日常开发，其中大量工程由编码智能体完成。请把它当作研究代码而非生产可用软件：它可能仍有缺陷，代码风格与工程实践也可能不一致，请在自有环境中审阅并改造后再使用。
>
> 为公开发布，我们做过适配，因此它与我们的内部版本、也与《Exploring Super-agent Design: Towards a More Autonomous Agent System》描述的实现在若干处并不相同。文中讨论的某些设计属于后续方向，本原型尚未实现。

SuperAgentArea 是面向团队「进来的一摊活」的主动式智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle 形式交付。新安装默认只带一个本地文件夹来源，GitHub 与飞书按需添加——每一种来源（Source kind）都可以开多个具名实例，每个实例各有自己的策略（Policy）与提示词——按版本化的策略判断请求是否准入，把获准的请求变成工单（Ticket），让每个工单在自己的智能体会话与目录里执行，再把结果与文件送回它来自的那个会话。Web 面板只展示需要人处理的事。

它也是一种与智能体协作的方式：**占用尽量少的人类注意力，产出尽量多的价值。** 一个能替整个团队行动的智能体，也可能浪费整个团队的注意力，所以它只在被请求、或团队写下的规则允许时才行动，只在需要人做决定、或有人能用上结果时才发言。[docs/000-philosophy.md](docs/000-philosophy.md) 说明了这条原则以及对运维者的要求。

## 它能做什么

- **监听** 默认监听本地文件夹投件；添加远程文件夹账号后，通过 SFTP 监听另一台机器的收件目录；GitHub（issue、评论、pull request）、飞书群聊与钉钉会话在添加账号后监听。来源 *kind* 是可复用的实现，来源 *实例* 是它的一个具体监听配置，例如 `github:owner/name`、`folder:ops`。来源目录共十一类：本地文件夹、远程文件夹、GitHub、飞书、钉钉已实现；Gitee、微信、QQ、Telegram、企业微信应用、邮箱为「接入开发中」，账号可先保存。
- **默认从本地文件夹开始。** 新安装会播种一个 `folder` 实例：收件目录与交付目录在状态目录下（`<stateDir>/area/local/`），操作系统用户名即允许投件的操作者。只播种一次，删除后不会再出现。
- **先判断再行动。** 不调模型的规则门禁按来源、发送人、事件类型、授权范围与去重先筛一遍；再由模型在主 Session 上判定「接单 / 停止 / 忽略 / 未完成」。主动工作分 `off`、`observe`、`auto` 三档，`observe` 只记录「本来会做什么」，不真的做。
- **开的是工单，不是聊天会话。** 接单会同时生成一份不可变授权（Mandate，说明谁可以提、这件事能做到哪一步）和一个工单；工单持有自己的订阅、输入、派工与产物。
- **在自己的地方干活。** 每个工单跑在独立的执行器 Session 与目录里，按生产线提示词工作，能跨重启恢复，也能交还、重试或续做。
- **交付文件，而不只是回帖。** worker 把交付物写进 `deliver/`；报 `ready` 时执行器把文件提升、建立索引、在结果回复里点名，面板可直接下载。
- **只展示需要人的事。** 概览、工单源、工作站、产物、设置五个页；每个来源的「策略提示配置」在它的卡片、详情页与设置的工单源里；设置分四组：工单源（十一类来源项与账号）、路由与评估、执行器与执行环境、部署。

## 架构：把生产线装进 Super-agent

这套设计由两个输入合成：一是 T0–T5 的「生产线」流程，回答「一个任务怎么被拆开、执行、沉淀」；二是 Super-agent 的 Router/Worker 双层，回答「任务从哪来、谁授权、多任务怎么并存、失败了怎么恢复」。融合的结论是：**把生产线整体降为 Worker 的内部流程——Router 管「要不要做、谁来做、到哪了」，Worker 管「怎么做」。** 完整设计见 [plan/Superagent融合架构.md](plan/Superagent融合架构.md)。

![融合架构：L0 事件源进入 L1 Router，分派工单给 L2 Worker 生产线，L3 为共享态](plan/Superagent融合架构.png)

| 层 | 职责 | 在本仓库的落点 |
| --- | --- | --- |
| **L0 事件源** | GitHub/CI、群聊、文件夹投件、SFTP 远程收件目录、定时与内部事件，在边缘完成归一化 | `src/sources/`（`github*`、`feishu*`、`folder`、`remote`、`connectors`）实现同一份 `SourceKind` 契约，由 `SourceRegistry` 管理实例 |
| **L1 Router**（常驻；只协调，不执行业务） | Trigger 归一化 → Fast Path 规则 → Slow Path 评估 → 建单 → 按优先级与容量派工；订阅、上下文装配、看门狗、人工队列、看板 | `src/core/`（`Intake`、`Evals`、`Tickets`、`Assignments`、`Replies`，统一暴露为一个 `Engine`）、`src/policy.ts`、`src/app/passes.ts`、`src/app/outbox.ts` |
| **L2 Worker**（每工单一个：独立 Session、目录与上下文） | 理解 → 规划 → 试处理 dry-run → 特性分发 → 并行执行 → 产物与 Spill | `src/executor/dsh.ts`、`cordis.patch.yml` 里的 worker preset、`prompts/worker.md`、subagent |
| **L3 共享态** | 知识池、运行态、归档与回填、工具环境（存算分离） | SQLite `Store`、`<stateDir>/area/` 目录、产物索引；知识池与归档回填尚未实现 |

**边界原则。** Router 不碰业务细节：不读代码、不写方案。Worker 不碰全局状态：不建单、不改别的工单。人只出现在三个点：**授权、验收、升级。**

### 六个机制

| 机制 | 规则 | 本仓库状态 |
| --- | --- | --- |
| Fast Path / Slow Path | 规则按来源、发送人、事件类型、授权与去重做不调模型的筛选；再由模型判定「建新单 / 关联已有单 / 忽略」 | 已实现：admission 表 + 策略门禁，其后进入主 Session 的 Eval |
| Ticket + Mandate | 持久化工单（状态、汇报人、来源、验收口径、产物）+ 不可变授权（范围、工具、预算、批准人、有效期） | 已实现；token/时长/次数预算与租约未做 |
| Thread Subscription | 工单所在 Thread 的后续消息直通它的 Worker，不再过模型判定 | 已实现，含交还、仅上下文订阅与退订 |
| Inline & Spill / Chain of Recall | 上下文只放下一步要用的，其余落到文件、按引用回捞：Trigger → Thread → Ticket → Session → Artifact | 部分实现：compaction、结果裁剪与 `orchestrator_read`；知识池一侧未做 |
| Watchdog | 无进展、循环、偏航三类门禁；动作按 重试 → 换方案 → 换 Worker → 降级 → 人工 递进 | 部分实现：停滞、超时与模型服务健康检查；四类门禁属于治理阶段 |
| 持久化、恢复、存算分离 | 运行态与知识池分开；确定性重试与语义重试分开计次；换机器不丢工单 | 已实现：SQLite、持久化 effect 队列、幂等 outbox、中断派工恢复 |

### 本分支在原型之上补了什么

- **多来源、多实例。** 每种来源 kind 都能开多个具名实例，各自有健康条目、Setup 校验、统计、配置与迁移。本地文件夹来源（inbox → `TASK.md` → 工单 → outbox）已是默认来源：新安装会播种一个 `folder` 实例，收件/交付目录在 `<stateDir>/area/local/` 下，操作系统用户名可投件。来源目录共十一类：本地文件夹、远程文件夹、GitHub、飞书、钉钉、以及接入开发中的 Gitee、微信、QQ、Telegram、企业微信应用、邮箱（账号可保存，暂不接收消息）。远程文件夹 kind 通过 SFTP 监听另一台主机的收件目录，只用密钥认证并强校验主机密钥（见 [docs/006-deployment.md](docs/006-deployment.md#remote-folder-over-sftp)）；钉钉 kind 通过 Stream 模式长连接企业机器人，无需公网回调地址，接收私聊与群 @ 消息并在原会话回帖（见 [docs/006-deployment.md](docs/006-deployment.md#dingtalk-bot-optional-stream-mode)）。
- **每源策略与提示词。** 每个来源实例拥有自己的接单规则与提示词配置，入口在它卡片/详情页的「策略提示配置」；没保存过的实例继承安装默认。worker 读的是它工单来源的那份配置与该来源 kind 的默认技能，主 Session 读安装默认加已配置来源 kind 的默认技能并集；新的来源 kind 只需按 `skills/dsh-superagent-<kind>/SKILL.md` 提供自己的默认技能。
- **项目组（工作站）成为一等对象。** 活归属于工作站；项目未注册时由 Eval 拒绝并反问（`needsProject`），人回答后重新评估；内置 `workspace` 承接无归属的临时工单。
- **产物成为一等结果。** 交付文件在 `ready` 时收集、提升到工作站成果目录、按 hash 与大小建索引、随结果回复交付、面板可下载，并可 **产物 → 工单 → 派工 → worker Session** 逐级反查。
- **面板按「活」重建。** 概览、工单源、工作站、产物、设置五个页，每个来源自己的策略与提示词，设置的四组（工单源、路由与评估、执行器与执行环境、部署），另有项目会话与项目历史。
- **中英双语界面**，以及 `<stateDir>/area/{workspace,<station>,<station>.work}` 目录模型：成果进工作站，副本留在同级副本目录。

## 状态

当前版本 **0.3.6**。P1–P6c 已全部完成：schema 12、来源多实例、项目归属前置、工单源/工作站/产物三个页面、项目会话与历史、以及收口项；**0.3.0** 已通过桌面端真实 E2E。**0.3.1/0.3.2** 把策略与提示词下沉到每个工单源实例，并拆出独立的「策略提示配置」页面（策略、提示词两个 Tab），每种来源 kind 提供自己的默认技能。**0.3.3** 新增「设置」Tab：来源项与多账号管理、两步添加来源、默认本地文件夹只播种一次、删除来源 API。**0.3.4** 让飞书常驻来源项目录；**0.3.5** 把添加来源的类型选择改为紧凑的四列网格；**0.3.6** 新增**远程文件夹（SFTP/SSH）**来源（仅密钥、known_hosts 强校验、不走 shell），来源项固定为 11 类顺序。**P8b** 让**钉钉**成为真实来源：企业自建应用机器人走 Stream 长连接，接收私聊与群 @ 消息并在原会话回帖；协议层参考 dsh-im（MIT，见 `THIRD_PARTY_NOTICES.md`）重写，不引入 dsh-im 依赖。QQ、微信仍为接入开发中。`pnpm check` 全绿，测试 1350 余项。后续工作记录在 [plan/24-IM与远程来源方案.md](plan/24-IM与远程来源方案.md)：移植 QQ/微信传输层（不依赖 dsh-im）、仓库站 worktree、L2 生产线提示词与技能、治理、知识池。

## 版本归档

每个打包构建都在 [releases/README.md](releases/README.md) 归档：SHA-256、源提交哈希、功能说明与相对上一版的对比（机器可读：[releases/manifest.json](releases/manifest.json)）。`.tgz` 包保留在仓库根目录，可据此重装某一版本，或用对应提交开 worktree 继续开发。回退到 0.1.x 前请阅读兼容性说明（数据库 schema 11/12 不可直接降级）。

## 安装

安装步骤较多，由智能体带着你完成。对你的编码智能体说：

> Read SETUP.md in this repository and set up dsh-superagent with me.

它一次只问一个短问题，最后把完整计划给你看一遍，确认后再安装配置。[SETUP.md](SETUP.md) 是它执行的清单。

## 文档

产品文档按顺序阅读，每篇只建立在前几篇之上。

- [000 设计哲学](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)：手工安装、配置、升级与排障
- [007 架构](docs/007-architecture.md)
- [008 扩展指南](docs/008-cookbook.md)：新增一种来源

设计档案记录了本分支是怎么一步步设计与实现的（中文）：

- [设计档案索引](plan/README.md)
- [融合架构](plan/Superagent融合架构.md)：本仓库遵循的四层设计，可编辑源图在 `plan/Superagent融合架构.drawio`
- [总体方案](plan/00-总体方案.md)：与原型逐条核实的差距分析与阶段计划
- [工作站与产物设计](plan/10-工作站与产物设计方案.md)：面板与领域模型的 v1.0 冻结设计
- [实施总结](plan/21-实施总结.md)：P1–P6 的提交、验证与已知限制
- [工单源策略与提示词](plan/22-工单源策略与提示词.md)：策略与提示词下沉到每个来源实例的方案与实施记录

## 开发

`pnpm check` 依次跑类型检查、测试与构建。

## 许可

[MIT](LICENSE)

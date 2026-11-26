# 设计档案（plan/）

本目录是 **SuperAgentArea（saa）** 改造过程的中文设计档案：从融合架构输入、总体方案、界面与数据模型设计，到 P1–P6c 每一步的实施说明与验收记录。英文产品文档在 [docs/](../docs/)，仓库总览见 [README.md](../README.md)。

> All documents in this folder are Chinese design notes. The English product documentation lives in [docs/](../docs/), and the [README](../README.md) is the project overview.

## 设计输入

| 文档 | 内容 |
| --- | --- |
| [Superagent融合架构.md](Superagent融合架构.md) | 四层融合架构（L0 事件源 / L1 Router / L2 Worker / L3 共享态）：把原图 T0–T5 生产线装进 Super-agent，含六个机制、数据模型、三条关键流程、里程碑与反模式。配图 [Superagent融合架构.png](Superagent融合架构.png)，可编辑源 [Superagent融合架构.drawio](Superagent融合架构.drawio) |

## 方案与设计

| 文档 | 内容 |
| --- | --- |
| [00-总体方案.md](00-总体方案.md) | 融合改造总体方案（v0.1）：与原型逐条核实的差距分析、L0 源扩展与阶段 1 folder 源详设、Artifact 文件输出、L2 生产线、治理、L3 知识池、里程碑与反模式 |
| [10-工作站与产物设计方案.md](10-工作站与产物设计方案.md) | **v1.0 设计冻结**：项目组（Project）一等对象、来源多实例、产物索引与反查、`<stateDir>/area/` 目录模型、工作站六段页 |
| [11-P1数据模型与接口设计.md](11-P1数据模型与接口设计.md) | P1 数据模型与 HTTP 接口设计（评审稿） |
| [22-工单源策略与提示词.md](22-工单源策略与提示词.md) | 策略与提示词下沉到每个工单源实例：每源规则与提示词版本、来源页「策略与提示词」分段、一级 Tab 收敛为四个工作页、默认技能按来源 kind 自动挂载；含实施完成记录 |
| [23-工作站Agent与对话.md](23-工作站Agent与对话.md) | 工作站 Agent 的要求与规则（工作站级提示词，注入会话与工单 worker）与一键会话（确定性 `project-<id>`、不再选择工作区、目录按工作站地址派生）；含远程文件夹会话的后续设计要点与实施记录 |
| [UI-审查报告.md](UI-审查报告.md) | 面板逐条审查（按 `文件:行号`）+ 新信息架构草案与待决策清单 |

## 阶段记录

| 文档 | 内容 |
| --- | --- |
| [阶段0-基线报告.md](阶段0-基线报告.md) | Windows + DSH `0.2.2-rc.5` 基线：`pnpm check` 全绿，40 项跨平台测试失败的分类修复 |
| [阶段1-E2E手册.md](阶段1-E2E手册.md) | folder 源 + 产物最小闭环的 E2E 手册与实测结果 |
| [12-P1b多实例实施说明.md](12-P1b多实例实施说明.md) | P1b：多实例来源（`<kind>:<key>`、folder 拆实例、registry `kindOf`/`instanceFor`、迁移） |
| [13-P2实施说明.md](13-P2实施说明.md) | P2：项目归属前置、`needsProject` 提问与回答重评、建单工单卡与 @ 提及 |
| [14-P2b补充说明.md](14-P2b补充说明.md) | P2b：显式请求的项目归属提问 + folder `QUESTION.md` 回答闭环 |
| [15-P3实施说明.md](15-P3实施说明.md) | P3：工单源页面（实例卡、统计、添加来源、未归属回答） |
| [16-P4实施说明.md](16-P4实施说明.md) | P4：工作站页面（项目组卡片 + 六段详情） |
| [17-P5实施说明.md](17-P5实施说明.md) | P5：产物索引页、下载与 worker 反查 |
| [18-P6a实施说明.md](18-P6a实施说明.md) | P6a：项目会话与项目历史 |
| [19-P6b实施说明.md](19-P6b实施说明.md) | P6b：界面收口（Prompts/Policy 一级页、设置齿轮、标签收敛） |
| [20-P6c实施说明.md](20-P6c实施说明.md) | P6c：实例级健康、具名来源 Setup 校验、停止写 `KV.artifacts` |
| [21-实施总结.md](21-实施总结.md) | P1–P6 总结：提交序列、交付能力、验证数据、已知限制与下一步 |

## 脚本

| 文件 | 用途 |
| --- | --- |
| [e2e-watch.mjs](e2e-watch.mjs) | folder 源投件 E2E（含中文 `TASK.md` 的任务文件夹） |
| [e2e-watch-020.mjs](e2e-watch-020.mjs) | 0.2.0 E2E：schema 12 迁移后的投件、workspace 项目与产物计数 |
| [e2e-final.mjs](e2e-final.mjs) | 0.3.0 最终 E2E：实例健康、投件、产物交付、项目/workspace 计数与历史 |

> 这些脚本按环境变量 `DSH_WEB_URL` 调用管理 API，属于当时的验证记录，不是 CI 测试。

# 使用技巧（use）

本目录放**配置与使用指南**，面向实际操作：怎么接来源、怎么填参数、怎么排错。设计与实现细节在 [plan/](../plan/README.md) 与 [docs/](../docs/)。

## 目录

- [远程文件夹配置（SSH/SFTP）](远程文件夹配置.md) —— 只有 IP/用户名/密码时怎么变成密钥登录并填面板
- [IM 接入说明（钉钉/QQ/微信）](IM接入说明.md) —— 当前各自怎么填、扫码创建机器人的可行性与要求
- [网页/地址监听](网页地址监听.md) —— 用 RSS/Atom/JSON 地址监听公开消息（随功能上线补充）

## 通用提示

- 所有来源都在 **设置 → 工单源** 里添加账号；每个账号是一个独立实例，有独立健康、策略与提示词。
- 来源项顺序：本地文件夹、远程文件夹、网页/地址、QQ、钉钉、微信、企业微信应用、邮箱、飞书、GitHub、Gitee、Telegram（以面板实际为准）。
- 入站附件会保存到 `<stateDir>/area/attachments/<kind>/<instance>/<messageId>/`，工单的 Trigger 文本里带绝对路径，Worker 可直接读取。
- 版本回退与历史包见 [history/](../history/README.md) 与 [releases/](../releases/README.md)。

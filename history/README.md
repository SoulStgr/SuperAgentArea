# 历史构建归档（history）

这里是 SuperAgentArea 的**历史打包备份**：每个已发布版本的 `.tgz` 安装包。当前最新版仍放在仓库根目录（`dsh-superagent-0.3.13.tgz`），历史版本移到本目录。

## 索引

| 版本 | 包 | 大小 | SHA-256（前 16） | 源提交 |
|---|---|---|---|---|
| 0.1.0 | `history/dsh-superagent-0.1.0.tgz` | 315,209 | `9c9ccf8fed52f103` | `73dfd0f`（压平，见注） |
| 0.1.1 | `history/dsh-superagent-0.1.1.tgz` | 315,294 | `ab7a52ffbc7e2e29` | 同上（压平） |
| 0.1.2 | `history/dsh-superagent-0.1.2.tgz` | 315,661 | `8d574b6de76d7c11` | 同上（压平） |
| 0.1.3 | `history/dsh-superagent-0.1.3.tgz` | 315,739 | `805bd66519f3d2bd` | 同上（压平） |
| 0.1.4 | `history/dsh-superagent-0.1.4.tgz` | 315,875 | `9ced85badce056a0` | `e69bdfe` |
| 0.1.5 | `history/dsh-superagent-0.1.5.tgz` | 315,995 | `f564b7edcc45be4e` | `e69bdfe` |
| 0.2.0 | `history/dsh-superagent-0.2.0.tgz` | 367,302 | `99796d69c8410faf` | `70a42be` |
| 0.2.1 | `history/dsh-superagent-0.2.1.tgz` | 375,550 | `0923795f5b18ba41` | `82554a5` |
| 0.2.2 | `history/dsh-superagent-0.2.2.tgz` | 378,207 | `e99d98690c626c7a` | `f52b079` |
| 0.2.3 | `history/dsh-superagent-0.2.3.tgz` | 378,443 | `79e4171feca80832` | `90d8f6f` |
| 0.3.0 | `history/dsh-superagent-0.3.0.tgz` | 379,980 | `a95e65ad803f9407` | `ef8f4b4` |
| 0.3.2 | `history/dsh-superagent-0.3.2.tgz` | 396,272 | `f5a6b73103ab8688` | `62ff18a`（等价树 `f25ce6a`） |
| 0.3.3 | `history/dsh-superagent-0.3.3.tgz` | 405,377 | `ebb700f316810dbc` | `85622d7`（构建）+ `0fb3f7b`（入库） |
| 0.3.4 | `history/dsh-superagent-0.3.4.tgz` | 405,422 | `93d1302fb0209115` | `0fb3f7b` |
| 0.3.5 | `history/dsh-superagent-0.3.5.tgz` | 405,998 | `dc6a22e17f6ddea3` | `255d98c` |
| 0.3.6 | `history/dsh-superagent-0.3.6.tgz` | 418,625 | `ec5f999ce09976e8` | `8c7108f` |
| 0.3.7 | `history/dsh-superagent-0.3.7.tgz` | 435,560 | `efcc3b0a7f7ba01b` | `1c6d61c` |
| 0.3.8 | `history/dsh-superagent-0.3.8.tgz` | 451,819 | `135773948bf91092` | `9450a36` |
| 0.3.9 | `history/dsh-superagent-0.3.9.tgz` | 469,236 | `d4af66c82d52d1eb` | `047437c` |
| 0.3.10 | `history/dsh-superagent-0.3.10.tgz` | 474,980 | `7b270de4db7e7848` | `c292ecd` |
| 0.3.11 | `history/dsh-superagent-0.3.11.tgz` | 480,502 | `38983fece03ed7ff` | `cc48e6f` |
| 0.3.12 | `history/dsh-superagent-0.3.12.tgz` | 487,824 | `fbd0ffae136ad8bd` | `a6455b6` |
| 0.3.13 | `history/dsh-superagent-0.3.13.tgz` | 491,481 | `e079dfa9a13e1bed` | `b29abae` |
| 0.3.14 | `history/dsh-superagent-0.3.14.tgz` | 510,789 | `3c8dfddb28ba8d2c` | `125103c` |
| 0.3.15 | `history/dsh-superagent-0.3.15.tgz` | 514,490 | `96f5bcb100fd12ac` | `2da92fe` |

最新版：`dsh-superagent-0.3.16.tgz`（仓库根目录）。

## 说明

- 完整说明、校验和与回退/重建步骤见 [../releases/README.md](../releases/README.md) 和 [../releases/manifest.json](../releases/manifest.json)。
- `0.1.0–0.1.3` 的原始构建提交在仓库历史压平前，无法从当前源码重建；包本身可用于回退。
- 安装历史版本：

```powershell
Copy-Item .\history\dsh-superagent-0.3.2.tgz "$env:USERPROFILE\.dsh\profiles\desktop\vendor\"
# 然后用 DSH 的 plugin_manager 安装：plugin_manager install_bundle file:vendor/dsh-superagent-0.3.2.tgz
```

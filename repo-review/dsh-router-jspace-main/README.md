# dsh-router-jspace

一个把 DeepSeek Harness 的三个生态项目组合成同一套 agent preset 的整合包：

- [J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)：推理时认知协议，负责 `fast/full/loop`、三寄存器、验证与恢复。
- [oh-we-need](https://github.com/scp3500/oh-we-need)：面向 DeepSeek V4 的 CoT 风格，负责 `we need to ...`、每步一个动作、先分类后执行。
- [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)：外部路由与运行时管理，负责 `spec/react/weak` 行为带、首轮工具面和 near-field 引导。

整合后的预设名为 `Router J-Space (experimental)`。外部路由负责“选模式”，J-Space 负责“选协议强度和保持状态”，oh-we-need 负责“让 V4 的推理文本变成可执行的工程思维”。

## 特性

- 任务首次进入时自动分类 `build / fix / weak`，并选择稳定行为带。
- J-Space 门控自动映射为 `fast / full / loop`，按任务类型加载对应模块。
- 保留首轮工具面收窄机制，首个持久工具调用后恢复完整 Standard 工具目录。
- 每条真实用户消息后追加 near-field 引导，动态内容不破坏 system 前缀缓存。
- 内置 `cog_ledger`，把 J-Space 账本持久化到 `$DSH_HOME/cognition-ledger/`。
- 自带 `j-space` 与 `oh-we-need` skills。
- 与 `dsh-mode-boost` 共存：注册 `router-persona` 与 `dev_router_status`，让 mode-boost 自动让位。

## 安装

```powershell
cd integrated-preset/router-jspace
.\scripts\install.ps1
```

脚本会安装：

- `$DSH_HOME\.agent-presets\router-jspace`
- `$DSH_HOME\skills\j-space`
- `$DSH_HOME\skills\oh-we-need`

安装后重启 DSH，新建会话选择 `Router J-Space (experimental)`。

## 工具

| 工具 | 作用 |
|---|---|
| `dev_router_status` | 查看当前 mode/band、J-Space pass/modules、账本路径 |
| `dev_router_mode` | 临时切换 `spec / weak / mixed / react` 或数值模式 |
| `dev_mode_subagent` | 在独立上下文中用另一种模式运行子任务 |
| `cog_ledger` | 维护 J-Space 账本，支持 `update / read / ship / clear` |

## 架构

```text
用户任务
  -> 外部路由：build/fix/weak -> spec/react/weak
  -> J-Space 门控：fast/full/loop
  -> 模块选择：capacity/broadcast/markers/self-monitoring 等
  -> oh-we-need：we need to ... 每步一个动作
  -> system-prompt/assemble 静态协议段 + 首轮工具面
  -> session/event near-field 引导
  -> cog_ledger 持久化账本与 ship 检查
```

详细机制见 [docs/三插件机制分析.md](docs/三插件机制分析.md) 与 [docs/整合设计与验证.md](docs/整合设计与验证.md)。

## 测试

```sh
npm test
```

当前覆盖：任务分类、chat 让位、pass/module 映射、near-field guide、persona/core/plan section 保留、mode 解析。

## 许可

本仓库代码使用 MIT；上游 J-Space 保留 Apache 2.0，其余上游组件保留各自 MIT/BSD 许可。完整声明见 [NOTICE.md](NOTICE.md) 与 `LICENSES/`。

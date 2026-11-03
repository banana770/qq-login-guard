# 贡献指南

欢迎 PR！本项目很小，规则也简单。

## 范围

✅ 欢迎：
- 适配其它协议端（LLOneBot / SnowLuma / Lagrange…），见 [docs/PROTOCOL_COMPAT.md](docs/PROTOCOL_COMPAT.md)
- 其它模拟器/真机的 ADB 适配与 UI 选择器改进
- 新通知通道、状态面板、测试、文档、i18n
- 更稳的重试/熔断策略（要有实测数据支撑）

❌ 不接受：
- 绕过风控、伪造设备指纹、破解协议
- 代扫/远程扫码/多账号矩阵
- 接入腾讯官方机器人（A 类，不属问题域）
- 任何用于批量骚扰/营销的能力

## 开发环境

- Node.js ≥ 22（零 npm 依赖）
- Windows 10/11 + 安卓模拟器（验证 ADB 相关改动需要）
- NapCat + 一个**小号**（不要用主号测试）

```bash
node test/state.test.mjs     # 状态归因单测
node test/guard.test.mjs     # 配置/熔断单测
node src/cli.mjs doctor      # 环境自检
node src/cli.mjs rehearse    # 扫码链路空跑（不点击）
```

## 代码约定

- **零依赖**优先；必须加依赖时先在 issue 里讨论；
- 探针/归因保持只读纯函数；副作用集中在 `src/actions.mjs` 与 `src/drivers/`；
- 新增策略必须进 `config`（有默认值、有校验），禁止写死；
- 新增动作必须有审计日志、失败可回退；
- Windows 专有命令要能降级（否则 Linux 直接崩）；
- 不提交 `config.local.json`、token、日志、截图中的个人信息。

## 提交 PR

1. Fork，分支名 `feat/xxx` / `fix/xxx`；
2. 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:`）；
3. PR 描述里写清楚：**改了什么 / 为什么 / 怎么验证的**（附 `doctor`/`rehearse`/`audit.jsonl` 片段）；
4. 涉及 ADB 流程的改动，必须附一次**真实掉线**的验证记录（可打码账号信息）。

## 报告问题

用 issue 模板，附：
- 版本 / OS / NapCat 版本 / 模拟器与手机 QQ 版本
- `node src/cli.mjs doctor` 输出
- 相关 `audit.jsonl` 片段（脱敏）
- 现象与复现步骤

安全相关问题请走 [SECURITY.md](SECURITY.md)，不要公开发敏感信息。

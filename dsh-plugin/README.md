# dsh-plugin（可选宿主壳）

把 `qq-login-guard` 接进 **DeepSeek Harness (DSH)** 的参考适配器：不内嵌自愈核心，只通过本地 HTTP 与 sidecar 通信。

> 这只是**一个参考实现**，不是产品必需。不用 DSH 也能用核心（CLI + 配置页）。其它宿主（AstrBot/NoneBot/自研）按 [../docs/ADAPTER.md](../docs/ADAPTER.md) 写自己的壳即可。

## 提供的工具（8 个）

| 工具 | 作用 |
|---|---|
| `qq_login_guard_status` | 实时状态 |
| `qq_login_guard_events` | 最近事件/审计 |
| `qq_login_guard_setup` | 打开配置页（路径输入框） |
| `qq_login_guard_start` | 启动 sidecar（attach/follow/embed，默认 dry-run） |
| `qq_login_guard_stop` | 停止 sidecar（SIGTERM→SIGKILL） |
| `qq_login_guard_heal` | 手动触发一次扫码自愈（live 且 QR_WAITING） |
| `qq_login_guard_doctor` | 环境自检 |
| `qq_login_guard_rehearse` | 扫码链路空跑自检（不点击） |

## 本地开发安装

DSH 宿主需要能解析 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
本目录的 `node_modules/` 是**本机 shim**（`export * from "file:///...你的DSH安装路径..."`），
已被 `.gitignore` 忽略，不会提交。

自己用时创建 shim（把路径换成你的 DSH 安装位置）：

```bash
mkdir -p node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/schemastery
# dsh-tools/package.json: {"name":"@deepseek-ai/dsh-tools","type":"module","main":"index.js"}
# dsh-tools/index.js:     export * from "file:///<你的DSH>/node_modules/@deepseek-ai/dsh-tools/lib/index.js";
# 同理 schemastery（需要同时导出 default）
```

或用本仓库的注入器（如你使用 dsh-super-injector）：

```bash
# 从仓库根目录
node -e "console.log('把 dsh-plugin 目录注入即可')"
```

## 配置项

`coreDir` / `configFile` / `guardUrl` / `token` / `autoStart` / `runMode` / `dryRun`。
`autoStart=true + runMode=embed` 可以实现「DSH 启动 → 拉起 sidecar → sidecar 拉起 NapCat」。

## 注意

- 若本机已有旧的 `guard.mjs` 在控制同一个 NapCat，只能留一个控制者，否则双头控制。
- 插件本身没有独立 UI 面板；"窗口"是 sidecar 提供的 `http://127.0.0.1:39100/setup` 配置页。

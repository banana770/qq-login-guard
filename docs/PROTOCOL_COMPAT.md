# 协议端适配指南（欢迎 PR）

> 当前状态：**只适配 NapCat**。
> 本文说明其它协议端（LLOneBot / SnowLuma / Lagrange.OneBot 等）差在哪、怎么接、怎么验收。

---

## 1. 为什么不能"直接通用"

所有协议端都对上层暴露 OneBot 11，所以**探活层**天然通用；但"登录态维护"依赖各家不同的东西：

| 能力 | NapCat（已适配） | 其它协议端 |
|---|---|---|
| 二维码从哪来 | `cache/qrcode.png`（文件）+ WebUI 刷新接口 | 文件位置/接口/日志链接各家不同 |
| 怎么重启/拉起 | `launcher-user.bat <QQ号>` | 各不相同（CLI 参数、配置文件、Docker） |
| 怎么判断"被踢" | 日志关键字 + OneBot 状态 | 日志格式不同，可能没有 `KickedOffLine` 字样 |
| 是否支持主动刷新二维码 | 有 WebUI API（可选） | 不一定 |
| 配置/凭据位置 | `config/onebot11_*.json` | 各不相同 |

---

## 2. 代码接缝（改这几处就能加一家）

| 接缝 | 位置 | 现状 |
|---|---|---|
| 配置 schema / 预设 | `src/config.mjs` 的 `DEFAULT_CONFIG`、`config.example.json` | 只有 NapCat 一套字段 |
| 二维码来源 | `src/probe.mjs` 的 `probeQr`（文件） | 文件路径；可扩展 WebUI API / 日志解析 |
| 日志关键字 | `src/probe.mjs` 的 `RISK_PATTERNS` / `KICK_PATTERNS` / `VERIFY_PATTERNS` | 按 NapCat 日志调过 |
| 拉起/重启 | `src/actions.mjs` 的 `launchNapcat` / `killNapcat` | 按 PID + `launcher-user.bat` |
| 协议端公共行为 | `src/orchestrator.mjs` | 协议端无关，一般不用改 |
| 设备/扫码执行 | `src/drivers/adb.mjs` | 与协议端无关（只要二维码文件存在） |

推荐做法：**加一个 `protocolEnd` 配置（如 `napcat` / `llbot` / `snowluma` / `lagrange`），在 config 里带一份默认值**（qr 路径、日志关键字、启动命令、刷新接口），核心代码只读配置，不写 `if (napcat)`。

---

## 3. 接入一家新协议端的检查清单

### 3.1 登录态可观测性

- [ ] OneBot 11 WS/HTTP 可用（`get_status` 能返回真实状态）
- [ ] 是否有"账号被踢"的明确日志行（贴 3 条真实日志样本到 PR）
- [ ] 是否有"风控/限制登录/需要验证"的日志关键字
- [ ] 被踢后是否还能出二维码？不能的话，重启方式是什么？
- [ ] 二维码文件路径（或获取接口），以及"是否新鲜"的判断方式（mtime / md5 / 接口时间戳）

### 3.2 生命周期

- [ ] 启动命令（能否无交互后台启动？是否需要账号参数？）
- [ ] 重启时如何"只杀自己"（PID/端口持有者/容器名），**不能误杀同机其它 QQ 进程**
- [ ] 登录成功后 OneBot 端口多久可用（决定 `waitForNapcatUp` 超时）

### 3.3 设备侧

- [ ] 二维码图片尺寸是否 ≥200×200（否则相册会过滤，需要放大——本工具已做）
- [ ] 扫码端仍是"模拟器/真机里的官方手机 QQ"（与协议端无关）

### 3.4 验收（PR 必须附）

1. `doctor` 输出（截图/文本）
2. `rehearse` 输出
3. 一次真实掉线的 `audit.jsonl` 片段：从检测到恢复的完整状态迁移
4. 失败路径至少一条：如二维码过期 / 页面不符预期时，是否**停手并通知**（不是死循环）

---

## 4. 不建议的适配

- 不要为"绕过风控"而适配（改设备指纹、伪造客户端、破解协议）——本项目不做，也不会合并。
- 不要适配**腾讯官方 QQ 机器人**（A 类）：它没有真人登录态，不在问题域。
- 不要新增"代扫/远程扫码/多账号矩阵"能力。

---

## 5. 代码风格

- 零 npm 依赖（Node 内置能力优先），Node ≥ 22；
- 所有副作用集中在 `actions.mjs` 和 `drivers/`，探针/归因保持只读纯函数；
- 新增策略参数必须进 `config` 并给默认值，不能写死；
- 新增动作必须有审计日志 + 失败可回退；
- 不引入新的系统命令依赖（Windows 专有命令要能被替代或降级）。

---

## 6. 提交方式

1. Fork → 新建分支 `feat/protocol-llbot`；
2. 在 `docs/PROTOCOL_COMPAT.md` 的"已适配"表格里加一行（见下）；
3. 附上 §3.4 的验收材料；
4. 开 PR，标题格式：`feat(protocol): adapt LLOneBot`。

| 协议端 | 状态 | 适配者 | 备注 |
|---|---|---|---|
| NapCat | ✅ 已适配 | @qq-login-guard | 当前唯一支持 |
| LLOneBot / LuckyLilliaBot | ⬜ 待适配 | — | OpenOneBot 11，差异主要在启动方式 |
| SnowLuma | ⬜ 待适配 | — | OneBot 11 + HTTP API |
| Lagrange.OneBot | ⬜ 待适配 | — | C#/.NET，无 Release 分发 |

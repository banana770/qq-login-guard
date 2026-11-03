# 宿主适配层 ABI（Host Adapter ABI）

> 目的：让任何 AI-QQ 宿主（AstrBot / NoneBot2 / MaiBot / LangBot / Koishi / DSH / 自研桥）都能在一个小时内接上 `qq-login-guard`，而**不需要改核心、不需要理解 ADB/模拟器细节**。
>
> 适配层是**可选**的：不写适配器，用户直接跑 sidecar + 打开 `http://127.0.0.1:39100/setup` 也能用全部功能。

---

## 1. 分工

| 谁 | 负责 |
|---|---|
| **核心 sidecar** | 探测 NapCat 登录态、归因、重启/出码、驱动模拟器扫码、验证、熔断、通知、审计、本地配置页 |
| **宿主适配层** | ①在宿主 UI 里展示状态/事件；②提供"一键 heal"入口；③可选：托管 sidecar 进程（启动/停止/自启） |

适配层**不要**做：登录逻辑、ADB 操作、二维码处理、重启 NapCat。这些全部在核心。

---

## 2. 传输：本地 HTTP

默认 `http://127.0.0.1:39100`（`config.server.host/port`）。同机访问。

若配置了 `server.token`，除 `/health`、`/status`、`/events`、`/setup` 页面外，`/api/*` 与 `/heal` 需要：

```
Authorization: Bearer <token>
```

### 2.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok:true, ts, product}`，用于探活 |
| GET | `/status` | 完整状态快照（见 §2.2） |
| GET | `/events?limit=N` | 最近 N 条事件（内存环形缓冲，默认 30，最大 200） |
| POST | `/heal` | 手动触发一次自愈。**403**=dry-run 拒绝；**409**=`state_not_qr_waiting`；**202**=已受理 |
| GET | `/setup` | 配置页（浏览器打开，路径输入框） |
| GET | `/api/config` | 当前配置 JSON（含 `file` 路径） |
| POST | `/api/config` | 保存配置（校验失败返回 `{ok:false,errors}`） |
| POST | `/api/detect` | 路径检测：传入配置，返回每个路径的 `{path, check:{exists,...}}` |

### 2.2 `/status` 关键字段

```jsonc
{
  "ok": true,
  "product": "qq-login-guard",
  "running": true,
  "dryRun": true,
  "pid": 39244,
  "state": "ONLINE",            // 见状态机
  "stateLabel": "在线",
  "reason": "OneBot 在线且深度探测通过",
  "counts": { "offlineStrikes": 0, "restartsLastHour": 0, "healsLastDay": 0, "manualUntil": 0 },
  "profile": { "id": "main", "account": "…", "wsUrl": "ws://127.0.0.1:30011", "deviceDriver": "manual" },
  "lastProbe": { "online": true, "fakeAlive": true, "portListening": true, "qr": {…}, "log": {…} },
  "lastAction": { "kind": "heal", "ok": true, "…": "…" },
  "events": [ { "ts": "…", "level": "info", "msg": "…" } ]
}
```

### 2.3 状态机（适配层只展示，不自行推断）

`ONLINE` / `SUSPECT_OFFLINE` / `LOGIN_INVALID` / `QR_WAITING` / `VERIFY_REQUIRED` / `RISK_LIMITED` / `WS_HUNG` / `NAPCAT_DOWN` / `COOLDOWN` / `MANUAL_TAKEOVER` / `UNKNOWN`

- `ONLINE`：一切正常
- `QR_WAITING`：已有待扫码二维码 → 适配层可提示"可一键 heal"
- `VERIFY_REQUIRED` / `RISK_LIMITED`：**需要人工**，适配层应展示"请人工处理"，不要重试
- `COOLDOWN` / `MANUAL_TAKEOVER`：策略暂停中

---

## 3. 一个最小适配器（伪代码）

```js
const BASE = 'http://127.0.0.1:39100';

async function status() {
  const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(3000) });
  return r.json();                       // 拿 state / stateLabel / counts
}

async function heal() {
  const r = await fetch(`${BASE}/heal`, { method: 'POST' });
  if (r.status === 403) return '当前是 dry-run，未执行';
  if (r.status === 409) return '当前不在等待扫码状态';
  return '已受理，稍后在 /status 看结果';
}

// 宿主启动时（可选）：托管 sidecar
function startSidecar() {
  const child = spawn('node', ['<coreDir>/src/cli.mjs', 'run', '--mode', 'attach', '--live'], {
    cwd: '<coreDir>', detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}
```

参考实现：`dsh-plugin/lib/index.js`（7 个工具 + stop/start 管理，~250 行）。

---

## 4. 生命周期约定

1. **先探活再动作**：宿主启动时先 `GET /health`；不通时再决定是否托管启动 sidecar。
2. **不要同时启动两个**：核心有 `guard.lock` 单实例锁；宿主侧重复 spawn 只会拿到第二个实例的失败日志。优先用 `/status.running` 判断。
3. **不要绕过策略**：`dryRun` 时 `/heal` 会 403；`MANUAL_TAKEOVER` 时不要提示用户重试。
4. **停用**：`POST /heal` 不受影响；要停 sidecar 就杀 `guard.lock` 里的 PID（SIGTERM → SIGKILL），或调用你封装的 stop。
5. **端口冲突**：若改过 `server.port`，适配层的 baseUrl 也要同步（DSH 适配器用 `guardUrl` 配置项）。

---

## 5. 接一个新宿主要做的 4 件事

1. 读配置（或写死）`qq-login-guard` 的 `coreDir` / `guardUrl` / `token`；
2. 注册 3 个入口：**状态展示**、**事件/日志**、**一键 heal**；
3. （可选）注册 **启动/停止 sidecar**；
4. 若宿主有"掉线通知"机制，可订阅本适配器展示的状态变化做二次转发（但跨通道通知应由核心 `notify` 负责，因为 QQ 挂了不能靠 QQ 通知自己）。

> 接好后在 README 的适配器表里加一行，PR 欢迎。

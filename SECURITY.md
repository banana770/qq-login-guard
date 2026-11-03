# 安全策略

## 安全模型

本工具是**本地单用户**工具，默认只监听 `127.0.0.1`，不对外提供服务。

| 资产 | 风险 | 现有措施 |
|---|---|---|
| OneBot token | 泄露后他人可操作你的协议端 | 支持环境变量 `QQ_LOGIN_GUARD_TOKEN`；审计日志脱敏；配置文件在 `.gitignore` |
| 登录二维码 | 泄露 = 账号控制权 | 只在本机文件/本机设备间流转；扫码成功后立即删除（阅后即焚） |
| 模拟器内手机 QQ | 与 NapCat 同号，账号级处置会同时影响两端 | 检测到风控/验证即停手，不循环操作 |
| 本地 HTTP API | 本机其它程序可调用 `/heal` | 默认仅 127.0.0.1；可设 `server.token` 要求 Bearer；`/heal` 在 dry-run 下直接 403 |
| 执行动作 | 误杀用户其它 QQ 进程 | 按端口持有者 PID 精准关停，禁止按镜像名杀 |
| 文件删除 | 误删用户相册 | 只删本工具产生的 `qr_fresh.png` 与本地临时图 |

## 你可以做的加固

1. token 不要写进配置文件，改用环境变量；
2. 给状态服务设一个 `server.token`（配置页/接口需要带 Bearer）；
3. 不要把 `.qq-login-guard/audit.jsonl`、`config.local.json` 发到公开渠道；
4. 不要把二维码截图发群/论坛。

## 报告漏洞

请通过 GitHub 仓库的 **Private vulnerability reporting**（Security → Advisories）提交，或在 issue 中只描述"存在安全问题，申请私下联系"，**不要公开可复现细节 / token / 账号信息**。

我们会在确认后尽快修复并在 release notes 致谢（如你愿意署名）。

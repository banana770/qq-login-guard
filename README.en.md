# qq-login-guard (English)

> Host-agnostic **login self-healing sidecar** for real QQ accounts logged in via [NapCat](https://github.com/NapNeko/NapCatQQ) (OneBot v11).
>
> When the account gets kicked by Tencent's risk control, it: detects the logout → makes NapCat produce a login QR → drives the **official mobile QQ inside an Android emulator** through ADB + UIAutomator to scan it → **verifies the account is truly back online** → notifies you, with circuit breakers so it never hammers the login.

## Why

- AI frameworks (AstrBot / NoneBot / LangBot / Koishi / DSH / custom bridges) only need the account to be online; they cannot fix a kicked login.
- NapCat does not self-heal after a kick (it can silently idle without producing a new QR).
- Manual QR scanning every 1–2 hours is not sustainable. This tool automates the scanner side with a real Android device/emulator.

## Scope

- ✅ **B-class**: takeover of a real QQ account via a protocol end (NapCat).
- ❌ **Not** Tencent official bots (QQ Open Platform): they have no real-account login state, so there is nothing to heal.
- ❌ Not a fan-control bypass; no SMS/slider/appeal automation; no remote/delegated scanning.

## Requirements

- Windows 10/11, Node.js ≥ 22
- NapCat.Shell with OneBot v11 WebSocket enabled
- An Android emulator (MuMu 12 recommended) **with the same QQ account logged into mobile QQ**
- ADB access to that emulator

## Quick start

```bat
:: 1) open the local config page (double-click also works: 0-打开配置页.bat)
node src\cli.mjs setup      :: -> http://127.0.0.1:39100/setup

:: 2) environment + scan-pipeline self check (no clicks)
node src\cli.mjs doctor
node src\cli.mjs rehearse

:: 3) observe first (dry-run), then switch to live
node src\cli.mjs run --mode attach
node src\cli.mjs run --mode attach --live
```

Modes: `attach` (wait for NapCat), `follow` (observe only), `embed` (guard launches NapCat — "start with NapCat").
Windows autostart: double-click `4-安装开机自启.bat`.

## Compatibility

- Protocol end: **NapCat only** (for now). Other OneBot v11 ends (LLOneBot / SnowLuma / Lagrange) are welcome as PRs — see [docs/PROTOCOL_COMPAT.md](docs/PROTOCOL_COMPAT.md).
- Emulator: MuMu 12 verified (1080×1920, mobile QQ 9.2.20); others are expected to work but untested.
- No AI framework required. Optional host adapters: [docs/ADAPTER.md](docs/ADAPTER.md) (a DeepSeek Harness plugin is included as reference).

## Safety

Default dry-run. Kills processes by PID (never by image name), deletes only its own files, stops and notifies on risk-control/verification states, and never automates SMS/slider/appeal. **No guarantee against account bans — do not test with a valuable account.** Read [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

## License

MIT

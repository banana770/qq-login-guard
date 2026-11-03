// dsh-plugin/lib/index.js — 把 qq-login-guard sidecar 接进 DeepSeek Harness
//
// 设计原则：插件不内嵌自愈核心，只做"宿主薄包装"：
//   - 读 sidecar 的 http://127.0.0.1:<port>/status /events
//   - 工具：状态、事件、打开配置页（路径输入框）、启动守护、手动自愈、doctor
//   - 配置项（DSH 设置页）：coreDir / configFile / guardUrl / autoStart / runMode / dryRun
// 注意：Cordis 的 ctx 不允许直接赋值新属性（cannot set property without provide），
// 所以配置用闭包持有，不写回 ctx。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-plugin-qq-login-guard';
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORE_DIR = path.resolve(HERE, '..', '..'); // qq-login-guard/
const NODE = process.execPath;

// 注入诊断：DSH 加载失败时 injector 不返回原因，这里把阶段落盘便于排查
const DIAG_FILE = path.join(path.dirname(HERE), 'apply-error.log');
function diag(msg) {
  try { appendFileSync(DIAG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}
diag('module-loaded');

export const Config = z.object({
  coreDir: z.string().default(DEFAULT_CORE_DIR).description('qq-login-guard 工程目录（含 src/cli.mjs）'),
  configFile: z.string().default('').description('sidecar 配置文件；留空则用 <coreDir>/config.local.json'),
  guardUrl: z.string().default('http://127.0.0.1:39100').description('sidecar 状态服务地址（server.host/port）'),
  token: z.string().default('').description('sidecar 状态服务 token（config.server.token，可留空）'),
  autoStart: z.boolean().default(false).description('插件加载时自动拉起 sidecar（默认关闭，避免与现有守护重复控制 NapCat）'),
  runMode: z.string().default('attach').description('autoStart 使用的模式：attach / follow / embed'),
  dryRun: z.boolean().default(true).description('autoStart 时是否 dry-run（默认 true，只观测不动作）'),
});

function resolveCfg(cfg = {}) {
  const coreDir = cfg.coreDir || DEFAULT_CORE_DIR;
  const configFile = cfg.configFile || path.join(coreDir, 'config.local.json');
  const guardUrl = (cfg.guardUrl || 'http://127.0.0.1:39100').replace(/\/+$/, '');
  return { coreDir, configFile, guardUrl, token: cfg.token || '', cli: path.join(coreDir, 'src', 'cli.mjs') };
}

async function httpJson(url, { method = 'GET', body, token = '', timeoutMs = 4000 } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

function stateLine(s) {
  const c = s?.counts ?? {};
  return [
    `状态: ${s?.stateLabel ?? s?.state ?? '未知'}`,
    `模式: ${s?.dryRun ? 'dry-run（只观测）' : 'live'} · 运行: ${s?.running ? '是' : '否'} · PID ${s?.pid ?? '-'}`,
    `原因: ${s?.reason || '-'}`,
    `计数: 离线 ${c.offlineStrikes ?? 0} · 重启(1h) ${c.restartsLastHour ?? 0} · 自愈(24h) ${c.healsLastDay ?? 0}`,
    s?.lastAction ? `最近动作: ${JSON.stringify(s.lastAction).slice(0, 240)}` : '最近动作: 无',
    s?.lastError ? `最近错误: ${s.lastError}` : '',
  ].filter(Boolean).join('\n');
}

function spawnDetached(cfg, args) {
  const r = resolveCfg(cfg);
  const env = { ...process.env, ...(r.token ? { QQ_LOGIN_GUARD_TOKEN: r.token } : {}) };
  const child = spawn(NODE, [r.cli, ...args], {
    cwd: r.coreDir,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, configFile: r.configFile };
}

async function ensureGuardRunning(cfg, { startIfDown = false } = {}) {
  const r = resolveCfg(cfg);
  try {
    const res = await httpJson(`${r.guardUrl}/status`, { token: r.token });
    if (res.ok && res.json) return { running: true, status: res.json };
  } catch { /* 下探 */ }
  if (!startIfDown) return { running: false, status: null };
  if (!existsSync(r.cli)) return { running: false, status: null, error: `找不到 ${r.cli}（检查 coreDir 配置）` };
  const mode = cfg.runMode || 'attach';
  const args = ['run', '--mode', mode, cfg.dryRun === false ? '--live' : '--dry-run'];
  const spawned = spawnDetached(cfg, args);
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 700));
    try {
      const res = await httpJson(`${r.guardUrl}/status`, { token: r.token });
      if (res.ok && res.json) return { running: true, status: res.json, spawned };
    } catch { /* retry */ }
  }
  return { running: false, status: null, spawned, error: 'sidecar 已启动但状态服务未就绪（看 <coreDir>/.qq-login-guard/audit.jsonl）' };
}

export function apply(ctx, config = {}) {
  diag('apply-enter');
  const CFG = config ?? {};
  const r = resolveCfg(CFG);

  const register = (tool, key) => ctx.effect(() => ctx.tools.register(tool), key);
  const out = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };

  /** 停掉本机 sidecar（读 guard.lock 的 PID，SIGTERM → 等 3s → SIGKILL） */
  async function stopSidecar() {
    const lockPath = path.join(r.coreDir, '.qq-login-guard', 'guard.lock');
    let pid = 0;
    try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid || 0; } catch { /* 无锁 */ }
    if (!pid) return { ok: false, reason: 'no_lock（守护可能未运行）' };
    try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, reason: String(e?.code || e?.message || e), pid }; }
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 300));
      try { process.kill(pid, 0); } catch { return { ok: true, pid, how: 'SIGTERM' }; }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    await new Promise((res) => setTimeout(res, 300));
    return { ok: true, pid, how: 'SIGKILL' };
  }

  register(defineTool({
    name: 'qq_login_guard_status',
    description: '查看 QQ 登录守护（NapCat 登录态自愈 sidecar）的实时状态：在线/掉线/等二维码/风控/需人工，以及重启与自愈计数。守护未运行时自动给出启动方式。',
    parameters: {},
    output: out,
    async execute() {
      const g = await ensureGuardRunning(CFG, { startIfDown: false });
      if (!g.running) {
        return `守护未运行。\n可让我执行 qq_login_guard_start，或手动：\n  cd ${r.coreDir}\n  node src/cli.mjs run --mode attach   # 默认 dry-run\n配置页（路径输入框）：qq_login_guard_setup`;
      }
      return stateLine(g.status);
    },
  }), 'qq_login_guard_status');

  register(defineTool({
    name: 'qq_login_guard_events',
    description: '读取 QQ 登录守护最近的事件/审计（状态变化、重启、自愈、通知）。',
    parameters: { limit: { type: 'number', description: '最多返回几条，默认 20' } },
    output: out,
    async execute(args) {
      try {
        const res = await httpJson(`${r.guardUrl}/events?limit=${Number(args.limit) || 20}`, { token: r.token });
        if (!res.ok) return `读取失败 HTTP ${res.status}`;
        const events = res.json?.events ?? [];
        if (!events.length) return '暂无事件。';
        return events.map((e) => `[${e.ts}] ${e.level} ${e.msg}`).join('\n');
      } catch (e) {
        return `守护未运行或状态服务不可达：${String(e?.message || e)}`;
      }
    },
  }), 'qq_login_guard_events');

  register(defineTool({
    name: 'qq_login_guard_setup',
    description: '打开/启动 QQ 登录守护的配置页。页面上有 NapCat 目录、adb.exe、模拟器快捷方式、设备端口、分辨率等路径输入框，并可"检测全部路径"。用于每台电脑路径不同的场景。',
    parameters: {},
    output: out,
    async execute() {
      let note = '';
      const h = await httpJson(`${r.guardUrl}/health`, { token: r.token }).catch(() => null);
      if (!h?.ok) {
        const spawned = spawnDetached(CFG, ['setup']);
        note = `\n（已拉起配置服务，PID ${spawned.pid ?? '?'}）`;
        for (let i = 0; i < 8; i++) {
          await new Promise((res) => setTimeout(res, 600));
          const hh = await httpJson(`${r.guardUrl}/health`, { token: r.token }).catch(() => null);
          if (hh?.ok) break;
        }
      }
      return `配置页: ${r.guardUrl}/setup${note}\n\n可以让我用 sidebar 打开这个地址。\n配置文件: ${r.configFile}`;
    },
  }), 'qq_login_guard_setup');

  register(defineTool({
    name: 'qq_login_guard_start',
    description: '启动 QQ 登录守护 sidecar（默认 attach 模式 + dry-run）。attach=等 NapCat 出现并接管；embed=先拉起 NapCat 再接管（"随 NapCat 启动"）；follow=只观察不拉起。',
    parameters: {
      mode: { type: 'string', description: 'attach / follow / embed，默认取插件配置' },
      live: { type: 'boolean', description: 'true=真正执行重启/扫码（默认 false 即 dry-run）' },
    },
    output: out,
    async execute(args) {
      const m = args.mode || CFG.runMode || 'attach';
      const live = args.live === true;
      const cur = await httpJson(`${r.guardUrl}/status`, { token: r.token }).catch(() => null);
      if (cur?.ok && cur.json?.running) return `守护已在运行：\n${stateLine(cur.json)}`;
      const spawned = spawnDetached(CFG, ['run', '--mode', m, live ? '--live' : '--dry-run']);
      for (let i = 0; i < 14; i++) {
        await new Promise((res) => setTimeout(res, 700));
        const res = await httpJson(`${r.guardUrl}/status`, { token: r.token }).catch(() => null);
        if (res?.ok && res.json?.running) {
          return `已启动（PID ${res.json.pid ?? spawned.pid}，模式 ${m}，${res.json.dryRun ? 'dry-run' : 'live'}）：\n${stateLine(res.json)}\n\n注意：若本机已有旧守护（如 guard.mjs）在控制同一个 NapCat，请先停旧的，避免双头控制。`;
        }
      }
      return `已拉起进程（PID ${spawned.pid ?? '?'}），但状态服务未就绪；看 ${path.join(r.coreDir, '.qq-login-guard', 'audit.jsonl')}`;
    },
  }), 'qq_login_guard_start');

  register(defineTool({
    name: 'qq_login_guard_heal',
    description: '手动触发一次扫码自愈（仅当当前状态是"等待扫码"且守护为 live 模式；dry-run 会被拒绝）。',
    parameters: {},
    output: out,
    async execute() {
      try {
        const res = await httpJson(`${r.guardUrl}/heal`, { method: 'POST', body: {}, token: r.token });
        if (res.status === 403) return '当前是 dry-run，未执行。把守护切到 live 后再试。';
        if (res.status === 409) return `拒绝执行：${res.json?.reason === 'state_not_qr_waiting' ? `当前状态 ${res.json?.state}，不是等待扫码` : res.json?.reason || 'unknown'}`;
        if (!res.ok) return `触发失败 HTTP ${res.status} ${res.text?.slice(0, 200) || ''}`;
        return '已受理自愈请求（后台执行；用 qq_login_guard_status 看结果）。';
      } catch (e) {
        return `守护未运行：${String(e?.message || e)}`;
      }
    },
  }), 'qq_login_guard_heal');

  register(defineTool({
    name: 'qq_login_guard_doctor',
    description: '对 qq-login-guard 做环境自检：路径是否存在、ADB 是否可用、OneBot 是否在线、token 是否解析、端口是否冲突。适合"换了电脑/路径不对"时先跑一次。',
    parameters: {},
    output: out,
    async execute() {
      if (!existsSync(r.cli)) return `找不到 ${r.cli}（检查 coreDir 配置）`;
      return await new Promise((resolve) => {
        const args = [r.cli, 'doctor', '--json'];
        if (r.configFile && existsSync(r.configFile)) args.push('--config', r.configFile);
        const child = spawn(NODE, args, { cwd: r.coreDir, windowsHide: true });
        let text = '';
        let err = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve('doctor 超时（60s）'); }, 60000);
        child.stdout.on('data', (d) => { text += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', () => {
          clearTimeout(timer);
          try {
            const report = JSON.parse(text);
            const icon = (s) => (s === 'pass' ? '✓' : s === 'warn' ? '!' : '✗');
            const lines = [`doctor: ${report.summary.pass} 通过 / ${report.summary.warn} 警告 / ${report.summary.fail} 失败`];
            for (const c of report.checks) lines.push(`${icon(c.status)} ${c.name}: ${c.detail}${c.hint && c.status !== 'pass' ? `\n    ↳ ${c.hint}` : ''}`);
            resolve(lines.join('\n'));
          } catch {
            resolve(text || err || 'doctor 无输出');
          }
        });
      });
    },
  }), 'qq_login_guard_doctor');

  register(defineTool({
    name: 'qq_login_guard_rehearse',
    description: '空跑自检：检查 ADB、模拟器/设备在线、分辨率、手机 QQ 是否安装、UIAutomator 是否可用（不点击、不扫码）。用于把守护切 live 之前确认扫码链路环境。',
    parameters: {
      launch_qq: { type: 'boolean', description: '顺带拉起手机 QQ 检查是否在消息主界面（仍不点击任何按钮）' },
    },
    output: out,
    async execute(args) {
      if (!existsSync(r.cli)) return `找不到 ${r.cli}（检查 coreDir 配置）`;
      return await new Promise((resolve) => {
        const argv = [r.cli, 'rehearse', '--json'];
        if (r.configFile && existsSync(r.configFile)) argv.push('--config', r.configFile);
        if (args.launch_qq === true) argv.push('--launch');
        const child = spawn(NODE, argv, { cwd: r.coreDir, windowsHide: true });
        let text = '';
        let err = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve('rehearse 超时（60s）'); }, 60000);
        child.stdout.on('data', (d) => { text += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', () => {
          clearTimeout(timer);
          try {
            const rep = JSON.parse(text);
            const lines = [`rehearse: ${rep.ok ? '全部通过' : '有失败项'}（${rep.serial}）`];
            for (const c of rep.checks) lines.push(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
            if (rep.hint) lines.push(`hint: ${rep.hint}`);
            resolve(lines.join('\n'));
          } catch {
            resolve(text || err || 'rehearse 无输出');
          }
        });
      });
    },
  }), 'qq_login_guard_rehearse');

  register(defineTool({
    name: 'qq_login_guard_stop',
    description: '停掉本机 qq-login-guard sidecar（读 guard.lock 的 PID，先 SIGTERM 再 SIGKILL）。用于切换 live/dry-run、改配置后重启，或避免与旧守护双头控制。',
    parameters: {},
    output: out,
    async execute() {
      const res = await stopSidecar();
      if (!res.ok) return `停止失败：${res.reason}`;
      return `已停止守护（PID ${res.pid}，${res.how}）。改完配置/模式后可用 qq_login_guard_start 重新启动。`;
    },
  }), 'qq_login_guard_stop');

  diag('apply-done tools=8');

  // 可选：插件加载即拉起 sidecar（默认关闭，避免与用户现有的 guard.mjs 双头控制）
  if (CFG.autoStart === true) {
    setTimeout(() => {
      ensureGuardRunning(CFG, { startIfDown: true }).catch(() => {});
    }, 1500).unref?.();
  }
}

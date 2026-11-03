#!/usr/bin/env node
// cli.mjs — qq-login-guard 命令行入口
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, saveConfig, normalizeConfig, validateConfig } from './config.mjs';
import { collectProbe, onebotCall } from './probe.mjs';
import { classify, STATE_META } from './state.mjs';
import { runDoctor, formatDoctor } from './doctor.mjs';
import { createStatusServer } from './server.mjs';
import { Guard } from './orchestrator.mjs';
import { isWindows, nowIso, run } from './util.mjs';

const HELP = `qq-login-guard — NapCat/OneBot 登录态自愈守护

用法: qq-login-guard <command> [options]

命令:
  init        交互式生成配置（路径因电脑而异，一步一步填）
  setup       启动本地配置页（浏览器输入框，改路径最方便）
  doctor      环境自检（路径、ADB、OneBot、端口、token）
  status      打印当前登录态（一次探测，不启动守护）
  run         启动守护（默认 dry-run；--live 才真正重启/扫码）
  once        只跑一轮"探测→归因→决策"，打印结果（dry-run）
  heal        手动触发一次扫码自愈（需 --live 且当前处于 QR_WAITING）
  rehearse    空跑自检：ADB/设备/分辨率/手机QQ/UIAutomator（不点击、不扫码）
  version     版本
  help        本帮助

通用选项:
  --config <file>   指定配置文件
  --profile <n>     使用第 n 个 profile（从 0 开始，默认 0）
  --json            机器可读输出
  --launch          rehearse 时顺带拉起手机 QQ 检查是否在消息主界面（仍不点击任何按钮）

run 选项:
  --mode attach|follow|embed   attach=等 NapCat 出现并接管（默认）
                               follow=只观察，绝不拉起 NapCat
                               embed=先拉起 NapCat 再接管（"随登录启动"）
  --live            关闭 dry-run（会真正执行重启/扫码！）
  --no-server       不启动本地状态/配置服务
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

async function openBrowser(url) {
  if (isWindows) await run('cmd.exe', ['/c', 'start', '', url], { timeoutMs: 5000 });
  else if (process.platform === 'darwin') await run('open', [url], { timeoutMs: 5000 });
  else await run('xdg-open', [url], { timeoutMs: 5000 });
}

async function cmdInit(args) {
  const rl = readline.createInterface({ input, output });
  const ask = async (q, def = '') => {
    const v = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return v || def;
  };
  try {
    console.log('— 生成 qq-login-guard 配置（直接回车用默认值）—\n');
    const cfg = normalizeConfig({});
    const p = cfg.profiles[0];
    const candidates = [
      path.join(process.cwd(), 'NapCat.Shell'),
      path.join(os.homedir(), 'NapCat.Shell'),
      'D:/NapCat.Shell',
      'C:/NapCat.Shell',
      'D:/NapCatQQ/NapCat.Shell',
    ];
    const detected = candidates.find((c) => existsSync(c)) || '';
    p.napcat.dir = await ask('NapCat.Shell 目录', detected);
    p.napcat.wsUrl = await ask('OneBot WS 地址', 'ws://127.0.0.1:30011');
    p.napcat.account = await ask('被接管 QQ 号', '');
    const driver = await ask('设备驱动 manual / mumu-adb / generic-adb', 'manual');
    p.device.driver = ['manual', 'mumu-adb', 'generic-adb'].includes(driver) ? driver : 'manual';
    if (p.device.driver !== 'manual') {
      p.device.adb.exe = await ask('adb.exe 路径（留空则从 PATH 找）', '');
      p.device.adb.host = await ask('设备地址', '127.0.0.1');
      p.device.adb.port = Number(await ask('设备端口（MuMu 16384 / 雷电 5555 / 夜神 62001）', '16384'));
      p.device.adb.coldStartShortcut = await ask('模拟器快捷方式（可选）', '');
    }
    const dry = await ask('先以 dry-run 运行（只观察不动作）？Y/n', 'Y');
    p.safety.dryRun = !/^n$/i.test(dry);
    const out = args.out || path.resolve('config.local.json');
    await saveConfig(out, cfg);
    console.log(`\n✓ 已写入 ${out}\n下一步：\n  node src/cli.mjs doctor\n  node src/cli.mjs run --mode attach`);
  } finally {
    rl.close();
  }
}

async function cmdSetup(args) {
  const { config, configDir, filePath } = await loadConfig(args.config);
  const port = Number(args.port || config.server?.port || 39100);
  const url = `http://127.0.0.1:${port}/setup`;

  // 守护已经在跑（状态服务被占用）→ 直接打开页面，不再重复起服务
  try {
    const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (h.ok) {
      console.log(`状态服务已在运行，直接打开配置页: ${url}`);
      await openBrowser(url).catch(() => {});
      return;
    }
  } catch { /* 未运行，继续起服务 */ }

  const srv = await createStatusServer({ guard: null, config, configDir, filePath, host: '127.0.0.1', port, token: config.server?.token || '' });
  console.log(`配置页: ${srv.url}/setup\n（改完保存即写入 ${filePath || path.join(configDir, 'config.local.json')}；Ctrl+C 退出）`);
  await openBrowser(`${srv.url}/setup`).catch(() => {});
  await new Promise(() => {});
}

async function cmdDoctor(args) {
  const { config, configDir, filePath } = await loadConfig(args.config);
  const report = await runDoctor({ config, configDir, filePath });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctor(report));
  process.exitCode = report.ok ? 0 : 2;
}

async function cmdStatus(args) {
  const { config, configDir } = await loadConfig(args.config);
  const { resolveProfile } = await import('./config.mjs');
  const resolved = resolveProfile(config, configDir, Number(args.profile || 0));
  const probe = await collectProbe(resolved);
  const cls = classify(probe, { staleQrMs: resolved.profile.policy?.staleQrMs ?? 240000 });
  if (args.json) {
    console.log(JSON.stringify({ ts: nowIso(), state: cls.state, label: STATE_META[cls.state]?.label, reason: cls.reason, evidence: cls.evidence, probe }, null, 2));
    return;
  }
  console.log(`状态: ${cls.state}（${STATE_META[cls.state]?.label}）`);
  console.log(`原因: ${cls.reason}`);
  console.log(`证据: ${cls.evidence.join(' | ') || '-'}`);
  console.log(`OneBot: reachable=${probe.onebot?.reachable} online=${probe.onebot?.online} fakeAlive=${probe.onebot?.fakeAlive} nickname=${probe.onebot?.nickname ?? '-'}`);
  console.log(`端口: ${probe.port?.host}:${probe.port?.port} listening=${probe.port?.listening}`);
  console.log(`二维码: exists=${probe.qr?.exists}${probe.qr?.exists ? ` age=${Math.round((probe.qr.ageMs ?? 0) / 1000)}s md5=${String(probe.qr.md5).slice(0, 8)}` : ''}`);
  console.log(`日志: exists=${probe.log?.exists} risk=${probe.log?.risk} verify=${probe.log?.verify} kicked=${probe.log?.kicked}`);
  const napcat = (probe.process?.processes ?? []).find((p) => /NapCat/i.test(p.name));
  console.log(`进程: ${napcat ? (napcat.running === null ? 'unknown' : napcat.running ? `running ${napcat.pids.join(',')}` : 'not-running') : '-'}`);
}

async function cmdOnce(args) {
  const { config, configDir, filePath } = await loadConfig(args.config);
  const guard = new Guard({ config, configDir, filePath });
  await guard.init({ mode: 'follow', dryRunOverride: true });
  try {
    const cls = await guard.tick();
    const snap = guard.snapshot();
    if (args.json) console.log(JSON.stringify(snap, null, 2));
    else {
      console.log(`状态: ${cls.state}（${STATE_META[cls.state]?.label}）`);
      console.log(`原因: ${cls.reason}`);
      console.log(`决策: ${snap.lastAction ? JSON.stringify(snap.lastAction) : '无动作（dry-run 只打印）'}`);
    }
  } finally {
    await guard.stop();
  }
}

async function cmdRun(args) {
  const { config, configDir, filePath } = await loadConfig(args.config);
  const mode = ['attach', 'follow', 'embed'].includes(args.mode) ? args.mode : 'attach';
  const guard = new Guard({ config, configDir, filePath });
  await guard.init({ mode, dryRunOverride: args.live ? false : undefined });
  const shutdown = async () => { console.log('\n正在停止守护…'); await guard.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`守护启动: mode=${mode} dryRun=${guard.dryRun} profile=${guard.resolved.profile.id}`);
  await guard.start({ server: !args['no-server'] });
}

async function cmdHeal(args) {
  const { config, configDir, filePath } = await loadConfig(args.config);
  const guard = new Guard({ config, configDir, filePath });
  await guard.init({ mode: 'follow' });
  try {
    const cls = await guard.tick();
    if (args.live) guard.resolved.profile.safety.dryRun = false;
    if (guard.dryRun) { console.log('当前是 dry-run，未执行。加 --live 才会真正扫码。'); return; }
    if (cls.state !== 'QR_WAITING') { console.log(`当前状态 ${cls.state}，不在 QR_WAITING，拒绝执行。`); return; }
    await guard.doHeal(cls);
    console.log(`结果: ${JSON.stringify(guard.lastAction)}`);
  } finally {
    await guard.stop();
  }
}

async function cmdRehearse(args) {
  const { config, configDir } = await loadConfig(args.config);
  const { resolveProfile } = await import('./config.mjs');
  const { createAdbDriver } = await import('./drivers/adb.mjs');
  const { createLogger } = await import('./logger.mjs');
  const resolved = resolveProfile(config, configDir, Number(args.profile || 0));
  if ((resolved.profile.device?.driver || 'manual') === 'manual') {
    console.log('提示：当前 device.driver=manual；rehearse 仍会用 device.adb 配置做设备自检。');
  }
  const logger = createLogger({ level: 'warn', jsonlPath: '', prefix: 'rehearse' });
  const driver = createAdbDriver({ resolved, logger, profileName: resolved.profile.id, dataDir: resolved.dataDir });
  const r = await driver.rehearse({ launchQq: args.launch === true });
  if (args.json) { console.log(JSON.stringify(r, null, 2)); process.exitCode = r.ok ? 0 : 2; return; }
  console.log(`rehearse: ${r.ok ? '全部通过' : '有失败项'}（${r.serial}）`);
  for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  if (r.hint) console.log(`hint: ${r.hint}`);
  process.exitCode = r.ok ? 0 : 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  switch (cmd) {
    case 'init': return cmdInit(args);
    case 'setup': return cmdSetup(args);
    case 'doctor': return cmdDoctor(args);
    case 'status': return cmdStatus(args);
    case 'run': return cmdRun(args);
    case 'once': return cmdOnce(args);
    case 'heal': return cmdHeal(args);
    case 'rehearse': return cmdRehearse(args);
    case 'version': console.log('qq-login-guard 0.1.0'); return;
    case 'help': default: console.log(HELP); return;
  }
}

main().catch((e) => {
  console.error(`错误: ${String(e && e.stack ? e.stack : e)}`);
  process.exitCode = 1;
});

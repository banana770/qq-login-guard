// install-autostart.mjs — 把 qq-login-guard 安装为 Windows 开机自启（登录时触发）
//
// 用法：
//   node scripts/install-autostart.mjs --check              # 只检查环境/冲突，不写系统
//   node scripts/install-autostart.mjs --mode attach        # dry-run 守护开机自启
//   node scripts/install-autostart.mjs --mode attach --live # live 守护开机自启
//   node scripts/install-autostart.mjs --mode embed         # 由守护拉起 NapCat（"随 NapCat 启动"）
//   node scripts/install-autostart.mjs --force              # 忽略"旧 guard.mjs 计划任务仍存在"的拦截
//
// 实现：生成 Task Scheduler XML（Hidden=true，无黑色控制台窗口）→ schtasks /Create
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const TASK_NAME = 'qq-login-guard';
const OLD_TASKS = ['napcat-bridge-guard', 'qq-login-guard-old'];

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--check') a.check = true;
    else if (s === '--live') a.live = true;
    else if (s === '--force') a.force = true;
    else if (s === '--mode' && argv[i + 1]) { a.mode = argv[++i]; }
    else a._.push(s);
  }
  return a;
}

function sh(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '') };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || e.stderr)) || e) };
  }
}

function taskExists(name) {
  const r = sh('schtasks.exe', ['/Query', '/TN', name]);
  return r.ok;
}

function whoami() {
  const r = sh('whoami.exe', []);
  if (r.ok && r.out.trim()) return r.out.trim();
  return `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
}

/** 解析真正的 node.exe：如果本脚本被 Electron/宿主进程执行，process.execPath 不是 node */
function resolveNodeExe() {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  if (base === 'node.exe' || base === 'node') return exe;
  const r = sh('where.exe', ['node.exe']);
  if (r.ok) {
    const first = r.out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }
  return exe;
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildXml({ user, mode, live, nodeExe }) {
  const args = [`"${CLI}"`, 'run', '--mode', mode];
  if (live) args.push('--live');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>qq-login-guard 开机自启：NapCat 登录态自愈（${live ? 'LIVE' : 'dry-run'} / ${mode}）</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodeExe)}</Command>
      <Arguments>${xmlEscape(args.join(' '))}</Arguments>
      <WorkingDirectory>${xmlEscape(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = ['attach', 'follow', 'embed'].includes(args.mode) ? args.mode : 'attach';
  const live = args.live === true;

  if (process.platform !== 'win32') {
    console.log('非 Windows：请用 systemd 用户服务（示例）：');
    console.log(`  ~/.config/systemd/user/qq-login-guard.service`);
    console.log(`  [Unit]\n  Description=qq-login-guard\n  [Service]\n  WorkingDirectory=${ROOT}\n  ExecStart=${process.execPath} ${CLI} run --mode ${mode}${live ? ' --live' : ''}\n  Restart=on-failure\n  [Install]\n  WantedBy=default.target`);
    process.exit(0);
  }

  if (!existsSync(CLI)) {
    console.error(`找不到 ${CLI}`);
    process.exit(1);
  }

  const user = whoami();
  const nodeExe = resolveNodeExe();
  const xml = buildXml({ user, mode, live, nodeExe });

  console.log('== qq-login-guard 开机自启安装器 ==');
  console.log(`任务名: ${TASK_NAME}`);
  console.log(`模式: ${mode}${live ? ' + LIVE（会真的重启/扫码）' : ' + dry-run（只观察）'}`);
  console.log(`用户: ${user}`);
  console.log(`Node: ${nodeExe}`);
  console.log(`命令: "${nodeExe}" "${CLI}" run --mode ${mode}${live ? ' --live' : ''}`);
  console.log(`工作目录: ${ROOT}`);

  // 1) 冲突检查：旧 guard.mjs 计划任务还在，会形成"双头控制"
  const conflicts = OLD_TASKS.filter((t) => t !== TASK_NAME && taskExists(t));
  if (conflicts.length) {
    console.log(`\n⚠ 检测到旧的守护计划任务: ${conflicts.join(', ')}`);
    console.log('  同时启用会和本工具抢同一个 NapCat（双头控制：两边都重启/抢二维码）。');
    console.log('  建议先停用旧的：');
    for (const t of conflicts) {
      console.log(`    schtasks /End    /TN ${t}`);
      console.log(`    schtasks /Change /TN ${t} /DISABLE`);
    }
    if (!args.check && !args.force) {
      console.log('\n已中止（未写系统）。确认要同时保留请加 --force（不推荐）。');
      process.exit(2);
    }
  }

  if (args.check) {
    console.log('\n[check] 环境检查完成；未创建任务。去掉 --check 即可安装。');
    console.log(`[check] 任务是否已存在: ${taskExists(TASK_NAME) ? '是' : '否'}`);
    return;
  }

  // 2) 生成 XML（schtasks 要求 UTF-16 LE）并创建
  const dir = path.join(ROOT, '.qq-login-guard');
  mkdirSync(dir, { recursive: true });
  const xmlFile = path.join(dir, 'autostart-task.xml');
  writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));

  const create = sh('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F']);
  if (!create.ok) {
    console.error('\n✗ 创建计划任务失败：');
    console.error(create.out.trim().slice(0, 1200));
    console.error('\n通常需要以管理员身份运行（右键 → 以管理员身份运行），或检查任务计划程序服务。');
    process.exit(1);
  }
  console.log(`\n✓ 已创建计划任务 ${TASK_NAME}（登录后自动启动，隐藏窗口）`);
  console.log(`  查看: schtasks /Query /TN ${TASK_NAME} /V /FO LIST`);
  console.log(`  立即启动一次: schtasks /Run /TN ${TASK_NAME}`);
  console.log(`  卸载: 双击 5-卸载开机自启.bat 或 schtasks /Delete /TN ${TASK_NAME} /F`);
  console.log(`  审计: ${path.join(ROOT, '.qq-login-guard', 'audit.jsonl')}`);
}

main();

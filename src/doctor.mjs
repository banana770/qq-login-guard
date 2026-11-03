// doctor.mjs — 安装自检：把"每台电脑路径不同"的坑变成可诊断项
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isWindows, resolveFrom, run, tcpProbe } from './util.mjs';
import { resolveProfile } from './config.mjs';
import { onebotCall, probeProcess } from './probe.mjs';

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

export async function runDoctor({ config, configDir, filePath = '' }) {
  const checks = [];
  const add = (name, status, detail, hint = '') => checks.push({ name, status, detail, hint });
  const p0 = config.profiles[0];
  const resolved = resolveProfile(config, configDir, 0);

  // 1. 运行时
  const major = Number(process.versions.node.split('.')[0]);
  add('Node 版本', major >= 22 ? PASS : FAIL, `v${process.versions.node}`, '需要 Node >= 22（内置 WebSocket / fetch）');
  add('操作系统', PASS, `${process.platform} ${process.arch}`, '');

  // 2. 配置文件
  add('配置文件', filePath ? PASS : WARN, filePath || '未找到，使用默认配置（可用 init/setup 生成）', 'qq-login-guard init 或打开 /setup');

  // 3. 路径
  const pathChecks = [
    ['NapCat 目录', resolved.napcatDir, '填写 NapCat.Shell 目录（含 cache/qrcode.png）'],
    ['二维码目录', resolved.qrPath ? path.dirname(resolved.qrPath) : '', '二维码文件所在目录，需可读写'],
    ['NapCat 日志', resolved.logPath, '可选；用于识别风控/验证关键字'],
    ['ADB 可执行文件', resolved.adbExe, '模拟器驱动需要；可留空从 PATH 查找 adb'],
    ['模拟器快捷方式', resolved.shortcut, '可选；模拟器未运行时用于冷启动'],
  ];
  for (const [name, p, hint] of pathChecks) {
    if (!p) {
      const optional = name !== 'NapCat 目录' && name !== '二维码目录';
      add(name, optional ? WARN : FAIL, '未配置', hint);
      continue;
    }
    try {
      await access(p, constants.R_OK);
      add(name, PASS, p);
    } catch {
      add(name, name.includes('日志') || name.includes('快捷方式') || name.includes('ADB') ? WARN : FAIL, `不存在: ${p}`, hint);
    }
  }

  // 4. 数据目录可写
  try {
    await mkdir(resolved.dataDir, { recursive: true });
    const probeFile = path.join(resolved.dataDir, '.doctor-probe');
    await writeFile(probeFile, 'ok');
    await unlink(probeFile);
    add('数据目录可写', PASS, resolved.dataDir);
  } catch (e) {
    add('数据目录可写', FAIL, resolved.dataDir, String(e?.message || e));
  }

  // 5. OneBot 连接
  const port = (() => { try { return Number(new URL(resolved.wsUrl).port) || 80; } catch { return 80; } })();
  const listening = await tcpProbe('127.0.0.1', port, 1500);
  add('OneBot 端口', listening ? PASS : WARN, `${resolved.wsUrl} ${listening ? '在监听' : '未监听'}`, '确认 NapCat 已启动且开启 OneBot WS 服务');
  if (listening) {
    const st = await onebotCall(resolved.wsUrl, resolved.token, 'get_status', {}, 5000);
    if (st.ok) {
      add('OneBot 鉴权/状态', PASS, `online=${st.data?.online === true} nickname=${st.data?.nickname ?? '-'}`);
    } else {
      add('OneBot 鉴权/状态', FAIL, `调用失败: ${st.error}`, '检查 token 是否正确（环境变量 QQ_LOGIN_GUARD_TOKEN 或配置 napcat.token）');
    }
  }
  add('Token 来源', resolved.token ? PASS : WARN, resolved.token ? '已解析（不显示）' : '为空：若 NapCat 未设 token 可忽略', '建议用环境变量而不是写进配置文件');

  // 6. 进程
  const procs = await probeProcess();
  if (!procs.available) add('进程探测', WARN, procs.error || '不可用', '无管理员权限时可能受限；不影响端口/WS 探测');
  else {
    for (const pr of procs.processes) add(`进程 ${pr.name}`, pr.running ? PASS : WARN, pr.running ? `运行中 PID ${pr.pids.join(',')}` : '未运行');
  }

  // 7. ADB / 设备
  if ((p0.device?.driver || 'manual') === 'manual') {
    add('设备驱动', WARN, 'manual（只通知）', '要全自动扫码请改 mumu-adb / generic-adb 并填 adb 路径与端口');
  } else {
    const adbExe = resolved.adbExe || (isWindows ? 'adb.exe' : 'adb');
    const v = await run(adbExe, ['version'], { timeoutMs: 6000 });
    add('ADB 可执行', v.code === 0 ? PASS : FAIL, v.code === 0 ? (v.stdout.split('\n')[0] || '').trim() : (v.stderr || 'adb 不可用').slice(0, 160), '填 adb.exe 绝对路径，或把 platform-tools 加入 PATH');
    if (v.code === 0) {
      const serial = `${p0.device?.adb?.host || '127.0.0.1'}:${p0.device?.adb?.port || 16384}`;
      await run(adbExe, ['connect', serial], { timeoutMs: 6000 });
      const ds = await run(adbExe, ['-s', serial, 'get-state'], { timeoutMs: 5000 });
      const online = ds.code === 0 && /device/.test(ds.stdout || '');
      add('设备连接', online ? PASS : WARN, `${serial} ${online ? '在线' : '未连接'}`, '先手动启动模拟器，或用快捷方式冷启动');
      if (online) {
        const size = await run(adbExe, ['-s', serial, 'shell', 'wm', 'size'], { timeoutMs: 6000 });
        add('设备分辨率', PASS, (size.stdout || '').trim());
      }
    }
  }

  // 8. 服务端口
  const srvPort = config.server?.port ?? 39100;
  const busy = await tcpProbe('127.0.0.1', srvPort, 800);
  add('状态服务端口', busy ? WARN : PASS, `127.0.0.1:${srvPort} ${busy ? '已被占用（可能守护已在运行）' : '可用'}`);

  const summary = {
    pass: checks.filter((c) => c.status === PASS).length,
    warn: checks.filter((c) => c.status === WARN).length,
    fail: checks.filter((c) => c.status === FAIL).length,
  };
  return { ok: summary.fail === 0, summary, checks, resolved: { napcatDir: resolved.napcatDir, qrPath: resolved.qrPath, dataDir: resolved.dataDir } };
}

export function formatDoctor(report) {
  const icon = (s) => (s === PASS ? '✓' : s === WARN ? '!' : '✗');
  const lines = [`qq-login-guard doctor — ${report.summary.pass} passed / ${report.summary.warn} warnings / ${report.summary.fail} failed`, ''];
  for (const c of report.checks) {
    lines.push(`${icon(c.status)} ${c.name}: ${c.detail}${c.hint && c.status !== PASS ? `\n    ↳ ${c.hint}` : ''}`);
  }
  lines.push('', report.ok ? '结论：可以启动（warn 项按需处理）' : '结论：存在阻塞项，先修 fail 再启动');
  return lines.join('\n');
}

export { PASS, WARN, FAIL };

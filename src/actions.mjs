// actions.mjs — 有副作用的动作（重启/拉起 NapCat），全部按 PID 精准操作
import { open, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isWindows, nowIso, run, sleep, tcpProbe, pidAlive, fileStat } from './util.mjs';
import { onebotCall, probePortOwner } from './probe.mjs';

/** 按 PID 精准关停 NapCat 进程树（绝不按镜像名杀 QQ.exe，避免杀掉用户主号） */
export async function killNapcat(resolved, logger) {
  const port = (() => { try { return Number(new URL(resolved.wsUrl).port) || 0; } catch { return 0; } })();
  const killed = [];

  // 1) 端口持有者（通常是注入后的 QQ 进程）→ 只杀它的进程树
  if (port) {
    const owner = await probePortOwner(port);
    if (owner.available && owner.pid) {
      if (isWindows) {
        await run('taskkill.exe', ['/T', '/F', '/PID', String(owner.pid)], { timeoutMs: 15000 });
      } else {
        await run('kill', ['-TERM', String(owner.pid)], { timeoutMs: 5000 });
        await sleep(800);
        if (pidAlive(owner.pid)) await run('kill', ['-KILL', String(owner.pid)], { timeoutMs: 5000 });
      }
      killed.push({ pid: owner.pid, role: 'port-owner' });
    }
  }

  // 2) NapCat 引导进程（按 PID，不用 /IM）
  if (isWindows) {
    const tl = await run('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq NapCatWinBootMain.exe'], { timeoutMs: 8000 });
    const pids = [...(tl.stdout || '').matchAll(/"NapCatWinBootMain\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
    for (const pid of pids) {
      await run('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { timeoutMs: 15000 });
      killed.push({ pid, role: 'napcat-boot' });
    }
  } else {
    const pg = await run('pgrep', ['-f', 'NapCatWinBootMain|napcat.*launcher|NapCat.Shell'], { timeoutMs: 5000 });
    const pids = (pg.stdout || '').trim().split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) {
      if (!pidAlive(pid)) continue;
      await run('kill', ['-KILL', String(pid)], { timeoutMs: 5000 });
      killed.push({ pid, role: 'napcat' });
    }
  }

  await sleep(1200);
  const stillListening = port ? await tcpProbe('127.0.0.1', port, 1200) : false;
  logger?.info('killNapcat 完成', { killed, stillListening });
  return { ok: !stillListening, killed, stillListening };
}

export async function deleteOldQr(resolved) {
  let removed = false;
  for (const p of [resolved.qrPath]) {
    if (p && existsSync(p)) {
      try { await unlink(p); removed = true; } catch { /* ignore */ }
    }
  }
  return { removed };
}

/** 拉起 NapCat（detached，输出追加到文件） */
export async function launchNapcat(resolved, logger) {
  const launch = resolved.profile.napcat?.launch ?? {};
  if (!launch.enabled) return { ok: false, reason: 'launch.disabled' };
  const cmd = launch.cmd || (isWindows ? 'cmd.exe' : 'bash');
  const args = (launch.args || []).map((a) => String(a).replaceAll('{account}', resolved.account || ''));
  const logFile = path.join(resolved.napcatDir || resolved.configDir, 'qq-login-guard.napcat.log');
  let fd = 'ignore';
  try { fd = await open(logFile, 'a'); } catch { fd = 'ignore'; }
  let child;
  try {
    child = spawn(cmd, args, {
      cwd: resolved.launchCwd || resolved.napcatDir || resolved.configDir,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    logger?.error('拉起 NapCat 失败', { error: String(e && e.message ? e.message : e) });
    return { ok: false, reason: 'spawn_failed', error: String(e) };
  } finally {
    try { if (typeof fd !== 'string') await fd.close(); } catch {}
  }
  logger?.info('已发出 NapCat 启动命令', { pid: child.pid, cmd, args: args.slice(0, 3) });
  return { ok: true, pid: child.pid, logFile };
}

/** 等待端口监听或二维码出现（谁先到算谁） */
export async function waitForNapcatUp(resolved, timeoutMs = 90000) {
  const port = (() => { try { return Number(new URL(resolved.wsUrl).port) || 0; } catch { return 0; } })();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (port && await tcpProbe('127.0.0.1', port, 800)) return { ok: true, how: 'port', waitedMs: Date.now() - started };
    const qr = await fileStat(resolved.qrPath);
    if (qr.exists) return { ok: true, how: 'qr', waitedMs: Date.now() - started };
    await sleep(1500);
  }
  return { ok: false, how: 'timeout', waitedMs: Date.now() - started };
}

/** 轮询 OneBot 是否真的恢复在线（用于验证自愈是否成功，替代"点完就当成功"） */
export async function waitForOnline(resolved, { timeoutMs = 45000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const st = await onebotCall(resolved.wsUrl, resolved.token, 'get_status', {}, 4000);
    last = st;
    if (st.ok && st.data?.online === true) {
      if (resolved.account) {
        const probe = await onebotCall(resolved.wsUrl, resolved.token, 'get_stranger_info', { user_id: Number(resolved.account) }, 4000);
        if (!(probe.ok && probe.retcode === 0)) { await sleep(intervalMs); continue; }
      }
      return { ok: true, waitedMs: Date.now() - started, status: st.data };
    }
    await sleep(intervalMs);
  }
  return { ok: false, waitedMs: Date.now() - started, last: last?.error ?? last?.retcode ?? null };
}

export const __test = { nowIso };

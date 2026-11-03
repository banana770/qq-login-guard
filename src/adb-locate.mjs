// adb-locate.mjs — 自动寻找 adb.exe（MuMu 常见安装位置 → PATH）
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWindows, run } from './util.mjs';

const MUMU_SUBDIRS = [
  'shell/adb.exe',
  'nx_main/adb.exe',
  'emulator/nemu/vmonitor/bin/adb.exe',
  'MuMuPlayer-12.0/shell/adb.exe',
  'MuMuPlayer-12.0/nx_main/adb.exe',
];

function roots() {
  if (!isWindows) return ['/usr/bin', '/usr/local/bin', '/opt/android-sdk/platform-tools'];
  const pf = process.env.ProgramFiles || 'C:/Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [pf, pf86, local, 'D:/Program Files', 'E:/Program Files'];
}

/** 静态候选路径（常见安装名） */
export function adbCandidates() {
  if (!isWindows) return ['/usr/bin/adb', '/usr/local/bin/adb', '/opt/android-sdk/platform-tools/adb'];
  const out = [];
  for (const root of roots()) {
    for (const name of ['Netease/MuMu Player 12', 'Netease/MuMuPlayer-12.0', 'MuMu Player 12', 'MuMuPlayer-12.0', 'MuMu/emulator']) {
      for (const sub of MUMU_SUBDIRS) out.push(path.join(root, name, sub));
    }
    out.push(path.join(root, 'platform-tools', 'adb.exe'));
    out.push(path.join(root, 'android-sdk', 'platform-tools', 'adb.exe'));
  }
  return out;
}

/** 动态扫描：在各盘/Program Files 下找名字含 MuMu 的目录（深度 2）再拼 adb */
function scanMumuDirs() {
  if (!isWindows) return [];
  const found = [];
  const seen = new Set();
  const scan = (dir, depth) => {
    if (depth > 2 || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (/mumu/i.test(e.name)) {
        for (const sub of MUMU_SUBDIRS) {
          const p = path.join(full, sub);
          if (existsSync(p)) found.push(p);
        }
      }
      scan(full, depth + 1);
    }
  };
  for (const root of [...roots(), 'D:/', 'E:/']) scan(root, 1);
  return found;
}

/**
 * 优先用显式配置；否则扫描 MuMu 常见路径/安装目录；最后回退到 PATH 上的 adb。
 * 找不到时返回 'adb.exe'（让后续命令报出可理解的错误）。
 */
export async function locateAdb(configured = '', logger = null) {
  const explicit = String(configured || '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  for (const c of adbCandidates()) {
    if (existsSync(c)) {
      logger?.info?.(`自动找到 adb: ${c}`);
      return c;
    }
  }
  const scanned = scanMumuDirs();
  if (scanned.length) {
    logger?.info?.(`自动找到 adb: ${scanned[0]}`);
    return scanned[0];
  }
  const which = isWindows
    ? await run('where.exe', ['adb.exe'], { timeoutMs: 3000 })
    : await run('which', ['adb'], { timeoutMs: 3000 });
  if (which.code === 0) {
    const first = which.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) {
      logger?.info?.(`从 PATH 找到 adb: ${first}`);
      return first;
    }
  }
  return isWindows ? 'adb.exe' : 'adb';
}

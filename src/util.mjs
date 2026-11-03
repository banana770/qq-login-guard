// util.mjs — 零依赖小工具
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const isWindows = process.platform === 'win32';

export function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 把配置文件里的相对路径按 config 目录或项目目录解析 */
export function resolveFrom(baseDir, p) {
  if (!p) return '';
  const expanded = expandHome(String(p));
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(baseDir, expanded);
}

export async function fileStat(p) {
  try {
    const st = await stat(p);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory() };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, isFile: false, isDirectory: false };
  }
}

export async function fileMd5(p) {
  try {
    return md5(await readFile(p));
  } catch {
    return '';
  }
}

/** 读文件尾部（按字节上限，避免把大日志读进内存） */
export async function tailBytes(p, maxBytes = 64 * 1024) {
  try {
    const st = await stat(p);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

export function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host || '127.0.0.1');
    } catch {
      done(false);
    }
  });
}

/** 运行命令并收集 stdout（带超时；失败返回 {code, stdout, stderr}） */
export function run(cmd, args = [], opts = {}) {
  const { cwd, timeoutMs = 15000, env } = opts;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message ? e.message : e) });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -2, stdout: out, stderr: err || 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

export function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function redact(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/(token|secret|password|authorization|cookie)([=:]\s*)[^\s,"']+/gi, '$1$2***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}

export function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

export { existsSync, path };

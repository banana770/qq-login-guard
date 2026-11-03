// logger.mjs — 控制台 + JSONL 审计
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { nowIso, redact } from './util.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ level = 'info', jsonlPath = '', echo = true, prefix = 'guard' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  async function write(levelName, msg, data) {
    const ts = nowIso();
    const line = `[${ts}] [${prefix}] ${msg}`;
    if (echo && LEVELS[levelName] >= threshold) {
      const fn = levelName === 'error' ? console.error : levelName === 'warn' ? console.warn : console.log;
      fn(line + (data !== undefined ? ` ${compact(data)}` : ''));
    }
    if (jsonlPath) {
      const rec = { ts, level: levelName, msg: redact(String(msg)) };
      if (data !== undefined) rec.data = redactValue(data);
      try {
        await mkdir(path.dirname(jsonlPath), { recursive: true });
        await appendFile(jsonlPath, JSON.stringify(rec) + '\n');
      } catch { /* 审计失败不阻断主流程 */ }
    }
  }

  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

function compact(data) {
  try {
    const s = JSON.stringify(redactValue(data));
    return s.length > 700 ? s.slice(0, 700) + '…' : s;
  } catch {
    return String(data);
  }
}

function redactValue(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|password|authorization|cookie/i.test(k)) out[k] = '***';
      else out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

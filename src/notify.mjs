// notify.mjs — 跨通道通知（QQ 挂了不能靠 QQ 通知自己）
import { nowIso } from './util.mjs';

const TEMPLATE = {
  QR_WAITING: (p) => `【QQ登录守护】${p.name} 掉线，已生成待扫码二维码。${p.extra || ''}`,
  HEAL_OK: (p) => `【QQ登录守护】${p.name} 自动扫码登录成功（耗时 ${p.extra || '?'}）。`,
  HEAL_FAIL: (p) => `【QQ登录守护】${p.name} 自动扫码失败：${p.extra || '未知原因'}。请人工介入。`,
  RISK_LIMITED: (p) => `【QQ登录守护】${p.name} 疑似被风控/限制登录：${p.extra || ''} 需要本人在手机 QQ 处理，已停止自动重试。`,
  VERIFY_REQUIRED: (p) => `【QQ登录守护】${p.name} 需要人工验证（短信/设备锁/申诉）：${p.extra || ''} 已停止自动重试。`,
  RESTARTED: (p) => `【QQ登录守护】${p.name} 已重启 NapCat：${p.extra || ''}`,
  GUARD_STARTED: (p) => `【QQ登录守护】${p.name} 守护已启动。`,
};

export function renderMessage(kind, payload = {}) {
  const fn = TEMPLATE[kind];
  const body = fn ? fn(payload) : `【QQ登录守护】${kind} ${payload.extra || ''}`;
  return { text: body, kind, at: nowIso() };
}

/**
 * channels: [{ type:'console' }, { type:'webhook', url, headers?, method? }, { type:'ntfy', topic, url? }]
 */
export async function notify(channels, kind, payload, logger) {
  const msg = renderMessage(kind, payload);
  const results = [];
  for (const ch of channels || []) {
    const type = ch.type || ch;
    try {
      if (type === 'console') {
        logger?.warn(`[notify] ${msg.text}`);
        results.push({ type, ok: true });
      } else if (type === 'webhook') {
        const res = await fetch(ch.url, {
          method: ch.method || 'POST',
          headers: { 'content-type': 'application/json', ...(ch.headers || {}) },
          body: JSON.stringify({ kind, text: msg.text, at: msg.at, payload }),
          signal: AbortSignal.timeout(8000),
        });
        results.push({ type, ok: res.ok, status: res.status });
      } else if (type === 'ntfy') {
        const base = (ch.url || 'https://ntfy.sh').replace(/\/+$/, '');
        const res = await fetch(`${base}/${encodeURIComponent(ch.topic)}`, {
          method: 'POST',
          headers: { Title: Buffer.from('QQ登录守护').toString('base64'), 'content-type': 'text/plain' },
          body: msg.text,
          signal: AbortSignal.timeout(8000),
        });
        results.push({ type, ok: res.ok, status: res.status });
      } else {
        results.push({ type, ok: false, error: 'unsupported' });
      }
    } catch (e) {
      results.push({ type, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  if (results.some((r) => !r.ok)) logger?.warn('部分通知通道失败', { results });
  return { message: msg, results };
}

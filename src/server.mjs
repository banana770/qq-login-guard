// server.mjs — 本地状态/配置 API（给 DSH/AstrBot/NoneBot 包装层与浏览器 setup 页共用）
import http from 'node:http';
import path from 'node:path';
import { normalizeConfig, saveConfig, validateConfig } from './config.mjs';
import { detectPaths, renderSetupPage } from './setup.mjs';
import { nowIso } from './util.mjs';

const MAX_BODY = 512 * 1024;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createStatusServer({ guard = null, config, configDir, filePath = '', host = '127.0.0.1', port = 39100, token = '', logger = null }) {
  let healing = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const p = url.pathname;
    try {
      // 鉴权：只对非页面接口生效；token 为空则本地免鉴权
      const needsAuth = token && (p.startsWith('/api/') || p === '/heal');
      if (needsAuth) {
        const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
        if (given !== token) return json(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (p === '/health') return json(res, 200, { ok: true, ts: nowIso(), product: 'qq-login-guard' });
      if (p === '/status') return json(res, 200, guard?.snapshot?.() ?? notRunning(config));
      if (p === '/events') {
        const limit = Math.min(200, Number(url.searchParams.get('limit') || 30));
        return json(res, 200, { ok: true, events: (guard?.events ?? []).slice(-limit) });
      }
      if (p === '/' || p === '/setup') {
        const cfg = guard?.config ?? config;
        const status = guard?.snapshot?.() ?? notRunning(cfg);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderSetupPage({ cfg, configFile: filePath, status }));
      }
      if (p === '/api/config' && req.method === 'GET') {
        return json(res, 200, { ok: true, file: filePath, config: guard?.config ?? config });
      }
      if (p === '/api/config' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return json(res, 400, { ok: false, errors: ['JSON 解析失败'] }); }
        const cfg = normalizeConfig(parsed);
        const v = validateConfig(cfg);
        if (!v.ok) return json(res, 400, { ok: false, errors: v.errors, warnings: v.warnings });
        const target = filePath || path.join(configDir, 'config.local.json');
        const saved = await saveConfig(target, cfg);
        if (guard) { guard.config = cfg; guard.resolved = { ...guard.resolved, profile: cfg.profiles[0] }; }
        logger?.info?.(`配置已保存: ${saved}`);
        return json(res, 200, { ok: true, file: saved, warnings: v.warnings, restartRequired: true });
      }
      if (p === '/api/detect' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        const entries = await detectPaths(normalizeConfig(parsed));
        return json(res, 200, { ok: true, entries });
      }
      if (p === '/heal' && req.method === 'POST') {
        if (!guard?.doHeal) return json(res, 409, { ok: false, reason: 'guard_not_running' });
        if (guard.dryRun) return json(res, 403, { ok: false, reason: 'dry-run' });
        const st = guard.currentState;
        if (healing) return json(res, 429, { ok: false, reason: 'heal_in_progress' });
        if (st !== 'QR_WAITING') return json(res, 409, { ok: false, reason: 'state_not_qr_waiting', state: st });
        healing = true;
        guard.doHeal(guard.lastClassify).catch((e) => logger?.error?.('手动自愈失败', { error: String(e?.message || e) })).finally(() => { healing = false; });
        return json(res, 202, { ok: true, accepted: true });
      }
      return json(res, 404, { ok: false, error: 'not_found', path: p });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://${host}:${addr.port}`,
        port: addr.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function notRunning(config) {
  return {
    ok: true,
    product: 'qq-login-guard',
    running: false,
    state: 'NOT_RUNNING',
    stateLabel: '守护未运行',
    ts: nowIso(),
    profile: { id: config?.profiles?.[0]?.id ?? 'main' },
    counts: { restartsLastHour: 0, healsLastDay: 0, offlineStrikes: 0 },
    events: [],
  };
}

// probe.mjs — 登录态多路探针（只读，不产生副作用）
import { fileMd5, fileStat, nowIso, tcpProbe, tailBytes, run, isWindows } from './util.mjs';

const RISK_PATTERNS = [
  /存在安全风险/, /部分功能使用受限/, /限制登录/, /1006514/, /禁止登录/, /账号被冻结/, /被封禁/,
];
const KICK_PATTERNS = [/KickedOffLine/i, /下线通知/, /登录已失效/, /当前账号已登录，无法重复登录/, /请重新登录/];
const VERIFY_PATTERNS = [/验证码/, /proofWaterUrl/, /需要验证/, /设备锁/, /短信验证/, /等待确认/, /请下载最新版QQ/];

export async function probePort(host, port, timeoutMs = 1200) {
  return { listening: await tcpProbe(host, port, timeoutMs) };
}

/** OneBot 11 调用（WS 一问一答）；失败返回 { ok:false, error } */
export function onebotCall(wsUrl, token, action, params = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout', action }), timeoutMs);
    try {
      ws = new WebSocket(wsUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, error: String(e && e.message ? e.message : e), action });
    }
    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ action, params, echo: `probe-${action}` })); } catch (e) { clearTimeout(timer); finish({ ok: false, error: String(e), action }); }
    });
    ws.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(String(ev.data)); } catch { return; }
      if (data && String(data.echo || '').startsWith('probe-')) {
        clearTimeout(timer);
        finish({ ok: true, action, retcode: data.retcode, status: data.status, data: data.data });
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, error: 'ws_error', action }); });
    ws.addEventListener('close', () => { clearTimeout(timer); finish({ ok: false, error: 'ws_closed', action }); });
  });
}

export async function probeOneBot(profile, timeoutMs = 6000) {
  const st = await onebotCall(profile.wsUrl, profile.token, 'get_status', {}, timeoutMs);
  if (!st.ok) {
    return { reachable: false, online: null, error: st.error, raw: null };
  }
  const online = st.data?.online === true;
  let fakeAlive = null;
  if (online && profile.account) {
    const probe = await onebotCall(profile.wsUrl, profile.token, 'get_stranger_info', { user_id: Number(profile.account) }, Math.min(timeoutMs, 4000));
    // NapCat 的 get_status 是乐观的：能拿到 retcode 0 才认为真实在线
    fakeAlive = probe.ok && probe.retcode === 0;
  }
  return {
    reachable: true,
    online,
    fakeAlive,
    nickname: st.data?.nickname ?? null,
    selfId: st.data?.user_id ?? null,
    raw: st.data ?? null,
    error: null,
  };
}

export async function probeQr(qrPath) {
  const st = await fileStat(qrPath);
  if (!st.exists) return { exists: false, path: qrPath, ageMs: null, mtimeMs: 0, md5: '' };
  const md5 = await fileMd5(qrPath);
  return { exists: true, path: qrPath, ageMs: Date.now() - st.mtimeMs, mtimeMs: st.mtimeMs, size: st.size, md5 };
}

export async function probeLog(logPath, { maxBytes = 64 * 1024, freshWindowMs = 10 * 60 * 1000 } = {}) {
  if (!logPath) return { exists: false, path: '', ageMs: null, risk: false, kicked: false, verify: false, tail: '' };
  const st = await fileStat(logPath);
  if (!st.exists || !st.isFile) return { exists: false, path: logPath, ageMs: null, risk: false, kicked: false, verify: false, tail: '' };
  const tail = await tailBytes(logPath, maxBytes);
  const recentLines = tail.split(/\r?\n/).filter(Boolean).slice(-120);
  const fresh = Date.now() - st.mtimeMs <= freshWindowMs;
  return {
    exists: true,
    path: logPath,
    ageMs: Date.now() - st.mtimeMs,
    fresh,
    risk: fresh && recentLines.some((l) => RISK_PATTERNS.some((re) => re.test(l))),
    kicked: fresh && recentLines.some((l) => KICK_PATTERNS.some((re) => re.test(l))),
    verify: fresh && recentLines.some((l) => VERIFY_PATTERNS.some((re) => re.test(l))),
    tail: recentLines.slice(-6).join('\n'),
  };
}

/** 进程探测：Windows 用 tasklist（失败不致命，沙箱/权限受限时返回 unknown） */
export async function probeProcess(names = ['NapCatWinBootMain.exe', 'QQ.exe']) {
  if (!isWindows) {
    const found = [];
    for (const name of names) {
      const r = await run('pgrep', ['-f', name.replace(/\.exe$/i, '')], { timeoutMs: 3000 });
      found.push({ name, running: r.code === 0 && r.stdout.trim().length > 0, pids: r.stdout.trim().split(/\s+/).filter(Boolean).map(Number) });
    }
    return { available: true, processes: found };
  }
  const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeoutMs: 8000 });
  if (r.code !== 0) {
    return { available: false, error: (r.stderr || 'tasklist failed').slice(0, 200), processes: names.map((n) => ({ name: n, running: null, pids: [] })) };
  }
  const lines = r.stdout.split(/\r?\n/);
  const processes = names.map((name) => {
    const pids = [];
    for (const line of lines) {
      if (!line.toLowerCase().includes(name.toLowerCase())) continue;
      const m = line.match(/"([^"]+)","(\d+)"/);
      if (m) pids.push(Number(m[2]));
    }
    return { name, running: pids.length > 0, pids };
  });
  return { available: true, processes };
}

/** 找出监听某端口的 PID（Windows: netstat -ano；用于按 PID 精准关停，绝不按镜像名杀 QQ） */
export async function probePortOwner(port) {
  if (!isWindows) return { available: false, pid: 0 };
  const r = await run('netstat.exe', ['-ano'], { timeoutMs: 8000 });
  if (r.code !== 0) return { available: false, pid: 0 };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${port} `)) continue;
    if (!/LISTENING/i.test(line)) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if (m) return { available: true, pid: Number(m[1]) };
  }
  return { available: true, pid: 0 };
}

/** 汇总一次完整探测 */
export async function collectProbe(profile) {
  const host = (() => {
    try { return new URL(profile.wsUrl).hostname; } catch { return '127.0.0.1'; }
  })();
  const port = (() => {
    try { return Number(new URL(profile.wsUrl).port) || 80; } catch { return 80; }
  })();
  const [onebot, portState, qr, log, procs] = await Promise.all([
    probeOneBot(profile).catch((e) => ({ reachable: false, online: null, error: String(e) })),
    probePort(host, port),
    probeQr(profile.qrPath),
    probeLog(profile.logPath),
    probeProcess(),
  ]);
  return { ts: nowIso(), onebot, port: { ...portState, host, port }, qr, log, process: procs };
}

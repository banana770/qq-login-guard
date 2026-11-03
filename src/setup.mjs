// setup.mjs — 宿主无关的本地安装/配置页（输入框在浏览器里，也供 DSH/AstrBot 侧栏打开）
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileStat } from './util.mjs';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 路径检测：把用户填的路径逐个验证，返回 exists 结果 */
export async function detectPaths(cfg) {
  const p = cfg.profiles?.[0] ?? {};
  const napcatDir = p.napcat?.dir || '';
  const qrPath = p.napcat?.qrPath || '';
  const logPath = p.napcat?.logPath || '';
  const adbExe = p.device?.adb?.exe || '';
  const shortcut = p.device?.adb?.coldStartShortcut || '';
  const joinIfRelative = (base, rel) => (base && rel && !path.isAbsolute(rel) ? path.join(base, rel) : rel);
  const qrAbs = joinIfRelative(napcatDir, qrPath);
  const logAbs = joinIfRelative(napcatDir, logPath);
  const entries = {
    napcatDir: { path: napcatDir, check: napcatDir ? await statOf(napcatDir) : null },
    qrPath: { path: qrAbs, check: qrAbs ? await statOf(qrAbs) : null },
    qrParent: { path: qrAbs ? path.dirname(qrAbs) : '', check: qrAbs ? await statOf(path.dirname(qrAbs)) : null },
    logPath: { path: logAbs, check: logAbs ? await statOf(logAbs) : null },
    adbExe: { path: adbExe, check: adbExe ? await statOf(adbExe) : null },
    coldStartShortcut: { path: shortcut, check: shortcut ? await statOf(shortcut) : null },
  };
  return entries;
}

async function statOf(p) {
  const st = await fileStat(p);
  if (!st.exists) return { exists: false };
  return { exists: true, isDirectory: st.isDirectory, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
}

export function renderSetupPage({ cfg, configFile = '', status = null }) {
  const p = cfg.profiles?.[0] ?? {};
  const napcat = p.napcat ?? {};
  const dev = p.device ?? {};
  const adb = dev.adb ?? {};
  const pol = p.policy ?? {};
  const channels = (p.notify?.channels ?? []).map((c) => (typeof c === 'string' ? c : c.type));
  const webhook = (p.notify?.channels ?? []).find((c) => c?.type === 'webhook')?.url ?? '';
  const ntfy = (p.notify?.channels ?? []).find((c) => c?.type === 'ntfy');
  const statusJson = status ? JSON.stringify(status, null, 2) : '';

  const field = (label, name, value, placeholder = '', hint = '', detect = true) => `
    <label class="field">
      <span class="label">${esc(label)}</span>
      <div class="row">
        <input id="${name}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">
        ${detect ? `<button type="button" class="mini" data-detect="${name}">检测</button>` : ''}
      </div>
      <span class="hint" id="hint-${name}">${esc(hint)}</span>
    </label>`;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>qq-login-guard 配置</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--text:#e6e9ef;--muted:#9aa4b2;--ok:#39d98a;--warn:#ffb020;--err:#ff5c5c;--accent:#5b9dff}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;margin:0 0 16px}
  h2{font-size:14px;margin:0 0 14px;color:var(--accent);letter-spacing:.4px}
  .field{display:block;margin:0 0 14px} .label{display:block;color:var(--muted);font-size:12px;margin-bottom:6px}
  .row{display:flex;gap:8px} input,select{flex:1;min-width:0;background:#0c0e12;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:9px 11px;font:inherit}
  input:focus,select:focus{outline:none;border-color:var(--accent)}
  .hint{display:block;color:var(--muted);font-size:12px;margin-top:5px;min-height:16px}
  .hint.ok{color:var(--ok)} .hint.warn{color:var(--warn)} .hint.err{color:var(--err)}
  button{cursor:pointer;border:0;border-radius:9px;padding:10px 16px;font:inherit;background:var(--accent);color:#06101f;font-weight:600}
  button.mini{background:#242a35;color:var(--text);padding:7px 12px;font-weight:500;flex:0 0 auto}
  button.ghost{background:#242a35;color:var(--text)}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px} @media(max-width:720px){.grid{grid-template-columns:1fr}}
  pre{background:#0c0e12;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-height:320px;font-size:12px}
  .note{color:var(--muted);font-size:12px;margin:10px 0 0}
  .ok{color:var(--ok)} .err{color:var(--err)} .warn{color:var(--warn)}
  .toast{position:fixed;right:18px;bottom:18px;background:#1d2430;border:1px solid var(--line);padding:12px 14px;border-radius:10px;display:none;max-width:420px;white-space:pre-wrap}
</style></head><body><div class="wrap">
<h1>qq-login-guard 配置</h1>
<p class="sub">路径因电脑而异，填好后点「保存配置」。保存后守护进程会按新配置运行（需重启守护）。${configFile ? `当前配置文件：<code>${esc(configFile)}</code>` : '尚未创建配置文件，保存时会生成。'}</p>

<div class="card"><h2>① NapCat / OneBot</h2>
  ${field('NapCat.Shell 目录（含 cache/qrcode.png）', 'napcatDir', napcat.dir, 'D:/NapCat.Shell')}
  <div class="grid">
    ${field('OneBot WS 地址', 'wsUrl', napcat.wsUrl, 'ws://127.0.0.1:30011')}
    ${field('被接管 QQ 号', 'account', napcat.account, '123456789')}
  </div>
  <div class="grid">
    ${field('二维码相对路径', 'qrPath', napcat.qrPath, 'cache/qrcode.png', '相对 NapCat 目录，或填绝对路径')}
    ${field('NapCat 日志（可选）', 'logPath', napcat.logPath, 'napcat_hidden.log', '用于识别风控/验证类关键字')}
  </div>
  ${field('OneBot Token（建议用环境变量）', 'token', napcat.token, '', '留空则读环境变量 QQ_LOGIN_GUARD_TOKEN')}
</div>

<div class="card"><h2>② 模拟器 / 手机（扫码执行器）</h2>
  <label class="field"><span class="label">驱动</span>
    <select id="driver">
      <option value="mumu-adb" ${dev.driver !== 'manual' && dev.driver !== 'generic-adb' ? 'selected' : ''}>mumu-adb — MuMu 模拟器（ADB + UIAutomator 全自动）[默认]</option>
      <option value="generic-adb" ${dev.driver === 'generic-adb' ? 'selected' : ''}>generic-adb — 其它模拟器/真机（雷电/夜神/真机）</option>
      <option value="manual" ${dev.driver === 'manual' ? 'selected' : ''}>manual — 只通知，人工扫码（没有安卓环境才选）</option>
    </select><span class="hint">默认就是 MuMu 全自动；没有安卓环境才选 manual。adb 路径留空会自动扫描 MuMu 安装目录与 PATH</span>
  </label>
  ${field('adb.exe 路径', 'adbExe', adb.exe, 'C:/platform-tools/adb.exe', '留空则自动扫描 MuMu 安装目录 / PATH')}
  <div class="grid">
    ${field('设备 ADB 地址', 'adbHost', adb.host, '127.0.0.1', 'MuMu 默认 127.0.0.1:16384')}
    ${field('设备 ADB 端口', 'adbPort', adb.port, '16384', '雷电 5555 / 夜神 62001 / 逍遥 21503')}
  </div>
  ${field('冷启动快捷方式（指向"模拟器里的 QQ"的 .lnk/.exe）', 'shortcut', adb.coldStartShortcut, 'C:/Users/me/Desktop/QQ-MuMu模拟器12.lnk', '设备未运行时双击它启动模拟器并进入手机 QQ；不是 QQ 安装包/apk 路径')}
  <div class="grid">
    ${field('手机 QQ 包名（模拟器内）', 'qqPackage', adb.qqPackage, 'com.tencent.mobileqq', '国服 QQ 默认即可；改包名通常是测试版/共存版', false)}
    ${field('QQ 启动 Activity', 'qqActivity', adb.qqActivity, 'com.tencent.mobileqq.activity.SplashActivity', '一般不用改；留空则用包名/SplashActivity', false)}
  </div>
  <div class="grid">
    ${field('相册目标路径（模拟器内）', 'remotePic', adb.remotePic, '/storage/emulated/0/DCIM/Camera/qr_fresh.png')}
    ${field('基准分辨率', 'resolution', `${adb.resolution?.width ?? 1080}x${adb.resolution?.height ?? 1920}`, '1080x1920', '坐标会按实际 wm size 缩放')}
  </div>
</div>

<div class="card"><h2>③ 策略 / 熔断</h2>
  <div class="grid">
    ${field('检查间隔 (ms)', 'checkIntervalMs', pol.checkIntervalMs, '30000')}
    ${field('连续离线几次触发重启', 'offlineStrikes', pol.offlineStrikes, '3')}
    ${field('动作冷却 (ms)', 'cooldownMs', pol.cooldownMs, '180000')}
    ${field('每小时最多重启', 'maxRestartPerHour', pol.maxRestartPerHour, '3')}
    ${field('每日最多自愈', 'maxAutoHealPerDay', pol.maxAutoHealPerDay, '12')}
    ${field('转人工后暂停 (ms)', 'manualPauseMs', pol.manualPauseMs ?? 1800000, '1800000')}
  </div>
  <label class="field"><span class="label">模式</span>
    <select id="dryRun">
      <option value="true" ${p.safety?.dryRun !== false ? 'selected' : ''}>dry-run — 只观测，不重启、不扫码（建议先跑一天）</option>
      <option value="false" ${p.safety?.dryRun === false ? 'selected' : ''}>live — 真正执行重启/扫码</option>
    </select><span class="hint">切换 live 前请先跑 doctor 并确认路径全部正确</span>
  </label>
</div>

<div class="card"><h2>④ 通知（可选，跨通道）</h2>
  ${field('Webhook URL', 'webhook', webhook, 'https://example.com/hook', 'POST JSON：{kind,text,at}')}
  <div class="grid">
    ${field('ntfy 主题（可选）', 'ntfyTopic', ntfy?.topic ?? '', 'qq-login-guard', '手机装 ntfy 订阅即可收推送')}
    ${field('ntfy 服务器（可选）', 'ntfyUrl', ntfy?.url ?? 'https://ntfy.sh', 'https://ntfy.sh')}
  </div>
</div>

<div class="actions">
  <button id="save">保存配置</button>
  <button class="ghost" id="detectAll">检测全部路径</button>
  <button class="ghost" id="refresh">刷新状态</button>
</div>
<p class="note">提示：保存后需要重启守护进程（<code>node src/cli.mjs run</code>）才会生效。状态：<span id="stateLine">加载中…</span></p>
<pre id="statusBox">${esc(statusJson || '点击「刷新状态」查看 /status')}</pre>
<div class="toast" id="toast"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const toast = (msg, ok = true) => { const t = $('toast'); t.textContent = msg; t.style.borderColor = ok ? '#2f7d55' : '#7d2f2f'; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 4200); };
const val = (id) => $(id) ? $(id).value.trim() : '';

async function loadConfig() {
  const res = await fetch('/api/config');
  const data = await res.json();
  if (!data.ok) return toast('读取配置失败: ' + (data.error || ''), false);
  const p = data.config.profiles[0]; const n = p.napcat, d = p.device, a = d.adb, pol = p.policy;
  const set = (id, v) => { if ($(id) != null) $(id).value = v ?? ''; };
  set('napcatDir', n.dir); set('wsUrl', n.wsUrl); set('account', n.account); set('qrPath', n.qrPath); set('logPath', n.logPath); set('token', n.token);
  $('driver').value = d.driver || 'manual';
  set('adbExe', a.exe); set('adbHost', a.host); set('adbPort', a.port); set('remotePic', a.remotePic); set('shortcut', a.coldStartShortcut);
  set('qqPackage', a.qqPackage || 'com.tencent.mobileqq'); set('qqActivity', a.qqActivity || 'com.tencent.mobileqq.activity.SplashActivity');
  set('resolution', (a.resolution?.width ?? 1080) + 'x' + (a.resolution?.height ?? 1920));
  set('checkIntervalMs', pol.checkIntervalMs); set('offlineStrikes', pol.offlineStrikes); set('cooldownMs', pol.cooldownMs);
  set('maxRestartPerHour', pol.maxRestartPerHour); set('maxAutoHealPerDay', pol.maxAutoHealPerDay); set('manualPauseMs', pol.manualPauseMs ?? 1800000);
  $('dryRun').value = String(p.safety?.dryRun !== false);
}

function buildConfig(base) {
  const cfg = JSON.parse(JSON.stringify(base));
  const p = cfg.profiles[0];
  p.napcat.dir = val('napcatDir'); p.napcat.wsUrl = val('wsUrl'); p.napcat.account = val('account');
  p.napcat.qrPath = val('qrPath'); p.napcat.logPath = val('logPath'); p.napcat.token = val('token');
  p.device.driver = $('driver').value;
  p.device.adb.exe = val('adbExe'); p.device.adb.host = val('adbHost'); p.device.adb.port = Number(val('adbPort') || 16384);
  p.device.adb.remotePic = val('remotePic'); p.device.adb.coldStartShortcut = val('shortcut');
  p.device.adb.qqPackage = val('qqPackage') || 'com.tencent.mobileqq';
  p.device.adb.qqActivity = val('qqActivity') || 'com.tencent.mobileqq.activity.SplashActivity';
  const m = /^(\\d+)\\s*x\\s*(\\d+)$/.exec(val('resolution') || '1080x1920');
  p.device.adb.resolution = { width: m ? Number(m[1]) : 1080, height: m ? Number(m[2]) : 1920, adaptive: true };
  p.policy.checkIntervalMs = Number(val('checkIntervalMs') || 30000);
  p.policy.offlineStrikes = Number(val('offlineStrikes') || 3);
  p.policy.cooldownMs = Number(val('cooldownMs') || 180000);
  p.policy.maxRestartPerHour = Number(val('maxRestartPerHour') || 3);
  p.policy.maxAutoHealPerDay = Number(val('maxAutoHealPerDay') || 12);
  p.policy.manualPauseMs = Number(val('manualPauseMs') || 1800000);
  p.safety.dryRun = $('dryRun').value === 'true';
  const channels = [];
  if (val('webhook')) channels.push({ type: 'webhook', url: val('webhook') });
  if (val('ntfyTopic')) channels.push({ type: 'ntfy', topic: val('ntfyTopic'), url: val('ntfyUrl') || 'https://ntfy.sh' });
  p.notify.channels = channels;
  return cfg;
}

async function save() {
  const res = await fetch('/api/config'); const data = await res.json();
  if (!data.ok) return toast('读取配置失败', false);
  const cfg = buildConfig(data.config);
  const r = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
  const out = await r.json();
  if (!out.ok) return toast('保存失败: ' + (out.errors || []).join('; '), false);
  toast('已保存到 ' + out.file + (out.warnings?.length ? '\\n提示: ' + out.warnings.join('; ') : ''));
  loadConfig(); refresh();
}

async function detectAll() {
  const res = await fetch('/api/config'); const data = await res.json();
  const cfg = buildConfig(data.config);
  const r = await fetch('/api/detect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
  const out = await r.json();
  const map = { napcatDir: 'napcatDir', qrPath: 'qrPath', logPath: 'logPath', adbExe: 'adbExe', coldStartShortcut: 'shortcut' };
  for (const [k, field] of Object.entries(map)) {
    const item = out.entries?.[k]; const hint = $('hint-' + field);
    if (!hint) continue;
    if (!item || !item.path) { hint.textContent = '未填写'; hint.className = 'hint warn'; continue; }
    if (k === 'qrPath') {
      // 二维码文件只在"需要扫码"时才存在：账号在线时不存在是正常的，不应标红
      if (item.check?.exists) { hint.textContent = '✓ 二维码文件存在（当前确实处于待扫码状态）'; hint.className = 'hint ok'; }
      else if (out.entries?.qrParent?.check?.exists) { hint.textContent = '⚠ 暂无二维码文件 —— 账号在线时正常；NapCat 下次掉线/需要扫码时会生成'; hint.className = 'hint warn'; }
      else { hint.textContent = '✗ 二维码目录不存在 — ' + (out.entries?.qrParent?.path || item.path); hint.className = 'hint err'; }
      continue;
    }
    if (item.check?.exists) { hint.textContent = '✓ 存在' + (item.check.isDirectory ? '（目录）' : '') + ' — ' + item.path; hint.className = 'hint ok'; }
    else { hint.textContent = '✗ 不存在 — ' + item.path; hint.className = 'hint err'; }
  }
  toast('路径检测完成');
}

async function refresh() {
  try {
    const r = await fetch('/status'); const s = await r.json();
    $('stateLine').innerHTML = '<b>' + (s.stateLabel || s.state) + '</b> · ' + (s.dryRun ? 'dry-run' : 'live') + ' · 重启(1h)=' + (s.counts?.restartsLastHour ?? '-') + ' · 自愈(24h)=' + (s.counts?.healsLastDay ?? '-');
    $('statusBox').textContent = JSON.stringify(s, null, 2);
  } catch (e) { $('stateLine').textContent = '守护未运行或状态服务未启动'; }
}

$('save').onclick = save; $('detectAll').onclick = detectAll; $('refresh').onclick = refresh;
document.querySelectorAll('[data-detect]').forEach(b => b.onclick = detectAll);
loadConfig().then(refresh); setInterval(refresh, 15000);
</script></body></html>`;
}

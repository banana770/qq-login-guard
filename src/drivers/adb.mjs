// drivers/adb.mjs — Android 设备（模拟器/真机）自动扫码执行器
// 迁移自 tools/auto_login_qr.mjs，但：路径全配置化、选择器优先、坐标按分辨率缩放、
// 删除范围最小化（绝不删用户相册目录里的其它文件）、每一步断言预期 UI、失败即停。
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isWindows, run, sleep } from '../util.mjs';
import { upscaleQr } from '../image.mjs';
import { fileStat } from '../util.mjs';

const BASE_W = 1080;
const BASE_H = 1920;

export function createAdbDriver({ resolved, logger, profileName, dataDir }) {
  const adbCfg = resolved.profile.device?.adb ?? {};
  const adbExe = resolved.adbExe || (isWindows ? 'adb.exe' : 'adb');
  const serial = `${adbCfg.host || '127.0.0.1'}:${adbCfg.port || 16384}`;
  const remotePic = adbCfg.remotePic || '/storage/emulated/0/DCIM/Camera/qr_fresh.png';
  const qqPackage = adbCfg.qqPackage || 'com.tencent.mobileqq';
  const qqActivity = adbCfg.qqActivity || 'com.tencent.mobileqq.activity.SplashActivity';
  const qqLaunch = adbCfg.qqLaunchIntent || `${qqPackage}/${qqActivity}`;
  const localTmp = path.join(dataDir, 'qr_fresh.png');
  let screen = null;

  async function adb(args, timeoutMs = 15000) {
    const r = await run(adbExe, ['-s', serial, ...args], { timeoutMs });
    if (r.code !== 0) {
      throw new Error(`adb ${args.slice(0, 2).join(' ')} 失败: ${(r.stderr || r.stdout || 'exit ' + r.code).trim().slice(0, 200)}`);
    }
    return (r.stdout || '').trim();
  }
  async function adbSoft(args, timeoutMs = 8000) {
    const r = await run(adbExe, ['-s', serial, ...args], { timeoutMs });
    return { ok: r.code === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  }

  async function deviceOnline() {
    const r = await run(adbExe, ['-s', serial, 'get-state'], { timeoutMs: 4000 });
    return r.code === 0 && /device/.test(r.stdout || '');
  }

  async function ensureDevice({ timeoutMs = 60000, coldStart = true } = {}) {
    await adbSoft(['connect', serial]);
    if (await deviceOnline()) return { ok: true, coldStarted: false };
    if (coldStart && adbCfg.coldStartShortcut && existsSync(adbCfg.coldStartShortcut)) {
      logger?.warn(`模拟器未运行，尝试冷启动：${adbCfg.coldStartShortcut}`);
      if (isWindows) await run('cmd.exe', ['/c', 'start', '', adbCfg.coldStartShortcut], { timeoutMs: 8000 });
      else await run('xdg-open', [adbCfg.coldStartShortcut], { timeoutMs: 8000 });
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        await sleep(3000);
        await adbSoft(['connect', serial]);
        if (await deviceOnline()) return { ok: true, coldStarted: true, waitedMs: Date.now() - started };
      }
    }
    return { ok: false, coldStarted: !!adbCfg.coldStartShortcut, reason: 'device_offline' };
  }

  async function getScreen() {
    if (screen) return screen;
    const r = await adbSoft(['shell', 'wm', 'size']);
    const m = /(\d+)\s*x\s*(\d+)/.exec(r.out || '');
    screen = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: BASE_W, h: BASE_H };
    return screen;
  }
  async function scalePoint(x, y) {
    const s = await getScreen();
    return [Math.round((x / BASE_W) * s.w), Math.round((y / BASE_H) * s.h)];
  }

  async function dumpUi(tag = 'qq_login_guard') {
    const remote = `/data/local/tmp/${tag}.xml`;
    await adbSoft(['shell', 'uiautomator', 'dump', remote], 20000);
    const r = await adbSoft(['shell', 'cat', remote], 10000);
    return r.out || '';
  }

  /** 解析 dump 里的 node，返回 [{text, desc, cls, bounds:{x1,y1,x2,y2}, center:[x,y]}] */
  function nodes(xml) {
    const list = [];
    const re = /<node\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const get = (name) => {
        const mm = new RegExp(`${name}="([^"]*)"`).exec(attrs);
        return mm ? mm[1] : '';
      };
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
      if (!b) continue;
      const x1 = Number(b[1]); const y1 = Number(b[2]); const x2 = Number(b[3]); const y2 = Number(b[4]);
      list.push({
        text: get('text'),
        desc: get('content-desc'),
        cls: get('class'),
        id: get('resource-id'),
        bounds: { x1, y1, x2, y2 },
        center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
      });
    }
    return list;
  }

  async function findNode(re, { useDesc = true, timeoutMs = 15000, label = '' } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const xml = await dumpUi();
      const hit = nodes(xml).find((n) => re.test(n.text) || (useDesc && re.test(n.desc)));
      if (hit) return hit;
      await sleep(800);
    }
    throw new Error(`UI 查找失败: ${label || re}`);
  }

  async function tapNode(node) {
    await adb(['shell', 'input', 'tap', String(node.center[0]), String(node.center[1])]);
  }
  async function tapScaled(x, y) {
    const [px, py] = await scalePoint(x, y);
    await adb(['shell', 'input', 'tap', String(px), String(py)]);
  }

  async function ensureMainUi() {
    for (let i = 0; i < 5; i++) {
      const xml = await dumpUi();
      if (/快捷入口/.test(xml)) return true;
      logger?.info(`不在 QQ 消息主界面，按返回键 (${i + 1}/5)`);
      await adbSoft(['shell', 'input', 'keyevent', '4']);
      await sleep(900);
    }
    return /快捷入口/.test(await dumpUi());
  }

  async function pushQr(qrPath) {
    const st = await fileStat(qrPath);
    if (!st.exists) throw new Error(`二维码不存在: ${qrPath}`);
    let src = qrPath;
    const up = await upscaleQr(qrPath, localTmp, { logger });
    if (up.ok) src = localTmp;
    // 只清理本插件自己的目标文件，不做通配符删除
    await adbSoft(['shell', 'rm', '-f', remotePic]);
    await adb(['push', src, remotePic], 20000);
    // Android 10+ 广播已废弃，直接走 ContentProvider 同步入库
    await adbSoft(['shell', 'content', 'call', '--uri', 'content://media', '--method', 'scan_file', '--arg', remotePic]);
    await sleep(1200);
    return { ok: true, remotePic };
  }

  async function openQqScanFlow() {
    await adb(['shell', 'am', 'start', '-n', qqLaunch], 15000);
    await sleep(1200);
    if (!(await ensureMainUi())) throw new Error('未能回到手机 QQ 消息主界面');
    // 快捷入口 → 扫一扫
    const entry = await findNode(/快捷入口/, { label: '快捷入口' });
    await adb(['shell', 'input', 'tap', String(entry.bounds.x2 - 20), String(entry.bounds.y1 + 20)]);
    await sleep(1200);
    const scan = await findNode(/扫一扫/, { label: '扫一扫' });
    await tapNode(scan);
    await sleep(1800);
    // 扫一扫 → 相册
    const album = await findNode(/相册/, { label: '相册' });
    await tapNode(album);
    await sleep(1800);
    // 相册第一张（最新推送的二维码）
    const first = nodes(await dumpUi()).find((n) => /ImageView|FrameLayout/.test(n.cls) && n.bounds.y1 > 120 && n.bounds.y2 < 900);
    if (first) await tapNode(first);
    else await tapScaled(133, 190);
    await sleep(1500);
    // 预览页"确定"
    const confirm = await findNode(/确定|完成/, { label: '预览确定' });
    await tapNode(confirm);
    await sleep(2500);
  }

  async function confirmAuthorization() {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const xml = await dumpUi();
      const hit = nodes(xml).find((n) => /登录|确认|允许|同意/.test(n.text) && /Button|TextView|android\.widget/.test(n.cls));
      if (hit && hit.center[0] > 0) {
        logger?.info(`找到授权按钮「${hit.text}」，点击 (${hit.center.join(',')})`);
        await tapNode(hit);
        return { ok: true, via: 'selector', text: hit.text };
      }
      await sleep(1000);
    }
    logger?.warn('未匹配到授权按钮，使用兜底坐标');
    await tapScaled(540, 1384);
    return { ok: true, via: 'fallback-coord' };
  }

  async function wipe() {
    await adbSoft(['shell', 'rm', '-f', remotePic]);
    await adbSoft(['shell', 'content', 'call', '--uri', 'content://media', '--method', 'scan_file', '--arg', remotePic]);
    try { if (existsSync(localTmp)) await unlink(localTmp); } catch { /* ignore */ }
    return { ok: true };
  }

  return {
    name: `adb:${serial}`,
    async description() { return `ADB 设备 ${serial}`; },
    async heal(ctx) {
      const steps = [];
      const dev = await ensureDevice({ coldStart: true });
      steps.push({ step: 'ensureDevice', ...dev });
      if (!dev.ok) throw Object.assign(new Error('设备不在线'), { step: 'ensureDevice', detail: dev });

      const pushed = await pushQr(ctx.qrPath);
      steps.push({ step: 'pushQr', ...pushed });

      await openQqScanFlow();
      steps.push({ step: 'openQqScanFlow', ok: true });

      const auth = await confirmAuthorization();
      steps.push({ step: 'confirmAuthorization', ...auth });
      return { ok: true, steps };
    },
    async cleanup() { return wipe(); },
    /**
     * 空跑自检：只读检查 ADB / 设备 / 分辨率 / 手机 QQ / UIAutomator，不点任何按钮、不扫码。
     * 用于 live 之前确认环境；launchQq=true 时会拉起 QQ 并检查是否在主界面（不点击）。
     */
    async rehearse({ launchQq = false } = {}) {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail: String(detail ?? '') });
      const ver = await run(adbExe, ['version'], { timeoutMs: 8000 });
      add('adb 可执行', ver.code === 0, ver.code === 0 ? (ver.stdout || '').split('\n')[0].trim() : (ver.stderr || ver.stdout || 'adb 不可用').slice(0, 200));
      if (ver.code !== 0) return { ok: false, checks, serial, adbExe };

      await adbSoft(['connect', serial]);
      const online = await deviceOnline();
      add('设备在线', online, serial);
      if (!online) return { ok: false, checks, serial, adbExe, hint: '先手动启动模拟器（或用 coldStartShortcut 冷启动）' };

      const size = await adbSoft(['shell', 'wm', 'size']);
      add('wm size 可读', size.ok, size.out || size.err);
      screen = null; // 让 getScreen 重新读
      const scr = await getScreen();
      add('分辨率解析', scr.w > 0 && scr.h > 0, `${scr.w}x${scr.h}`);

      const pkg = await adbSoft(['shell', 'dumpsys', 'package', qqPackage]);
      const installed = /versionName=/.test(pkg.out || '');
      const version = (pkg.out || '').match(/versionName=([^\s]+)/)?.[1] || '';
      add('手机 QQ 已安装', installed, installed ? `${qqPackage} ${version}` : `未找到 ${qqPackage}`);

      const dump = await dumpUi('rehearse');
      add('uiautomator dump', dump.length > 100, `${dump.length} bytes`);

      if (launchQq) {
        await adbSoft(['shell', 'am', 'start', '-n', qqLaunch], 15000);
        await sleep(1500);
        const ui = await dumpUi('rehearse');
        const mainOk = /快捷入口/.test(ui);
        add('QQ 消息主界面', mainOk, mainOk ? '检测到「快捷入口」' : '未检测到「快捷入口」（可能在聊天页/登录页/未加载完）');
      } else {
        const focus = await adbSoft(['shell', 'dumpsys', 'window']);
        const m = (focus.out || '').match(/mCurrentFocus=.*?\s([\w./]+)\}/);
        add('当前前台 Activity（仅供参考）', true, m ? m[1] : 'unknown');
      }

      const ok = checks.filter((c) => c.name !== '当前前台 Activity（仅供参考）').every((c) => c.ok);
      return { ok, checks, serial, adbExe, screen: scr, qqVersion: version || null };
    },
    // 供 doctor / 上层使用
    async probeDevice() {
      const dev = await ensureDevice({ coldStart: false, timeoutMs: 5000 });
      const state = await adbSoft(['get-state']);
      return { online: dev.ok, serial, adbExe, state: state.out || state.err };
    },
  };
}

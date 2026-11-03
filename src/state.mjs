// state.mjs — 登录态分类与状态机
export const STATES = {
  ONLINE: 'ONLINE',
  SUSPECT_OFFLINE: 'SUSPECT_OFFLINE',
  LOGIN_INVALID: 'LOGIN_INVALID',
  QR_WAITING: 'QR_WAITING',
  RISK_LIMITED: 'RISK_LIMITED',
  VERIFY_REQUIRED: 'VERIFY_REQUIRED',
  WS_HUNG: 'WS_HUNG',
  NAPCAT_NO_WS: 'NAPCAT_NO_WS',
  NAPCAT_DOWN: 'NAPCAT_DOWN',
  COOLDOWN: 'COOLDOWN',
  MANUAL_TAKEOVER: 'MANUAL_TAKEOVER',
  UNKNOWN: 'UNKNOWN',
};

export const STATE_META = {
  ONLINE: { label: '在线', severity: 'ok', auto: false },
  SUSPECT_OFFLINE: { label: '疑似假死离线', severity: 'warn', auto: true },
  LOGIN_INVALID: { label: '登录失效（等待扫码）', severity: 'warn', auto: true },
  QR_WAITING: { label: '等待扫码（已有二维码）', severity: 'warn', auto: true },
  RISK_LIMITED: { label: '账号被风控/限制登录（需本人处理）', severity: 'error', auto: false },
  VERIFY_REQUIRED: { label: '需要人工验证（短信/设备锁/申诉）', severity: 'error', auto: false },
  WS_HUNG: { label: '端口在但 OneBot 无响应', severity: 'warn', auto: true },
  NAPCAT_NO_WS: { label: 'NapCat 在跑但 OneBot 未就绪（未登录/卡住）', severity: 'warn', auto: true },
  NAPCAT_DOWN: { label: 'NapCat 未运行', severity: 'warn', auto: true },
  COOLDOWN: { label: '冷却中（限制重试）', severity: 'info', auto: false },
  MANUAL_TAKEOVER: { label: '已转人工（停止自动动作）', severity: 'error', auto: false },
  UNKNOWN: { label: '状态未知', severity: 'info', auto: false },
};

/**
 * 用一次探测结果判定状态。
 * 优先级：在线 > 风控/验证（需人工）> 登录失效/二维码 > 端口/进程 > 未知
 */
export function classify(probe, { staleQrMs = 240000 } = {}) {
  const ev = [];
  const onebot = probe.onebot ?? {};
  const qr = probe.qr ?? {};
  const log = probe.log ?? {};
  const port = probe.port ?? {};
  const proc = probe.process ?? {};
  const napcatProc = (proc.processes ?? []).find((p) => /NapCat/i.test(p.name)) ?? { running: null, pids: [] };

  if (onebot.reachable && onebot.online === true && onebot.fakeAlive !== false) {
    ev.push('get_status.online=true');
    if (onebot.fakeAlive === true) ev.push('get_stranger_info retcode=0');
    return mk(STATES.ONLINE, 'OneBot 在线且深度探测通过', ev);
  }
  if (onebot.reachable && onebot.online === true && onebot.fakeAlive === false) {
    ev.push('get_status.online=true', '深度探测失败 → 假死');
    return mk(STATES.SUSPECT_OFFLINE, 'NapCat 自报在线但真实探测失败（幽灵在线）', ev);
  }
  if (log.risk) {
    ev.push('日志命中风控/限制登录关键字');
    return mk(STATES.RISK_LIMITED, '账号被风控或限制登录，扫码无法解决，必须本人在手机 QQ 处理', ev);
  }
  if (log.verify) {
    ev.push('日志命中验证码/设备锁/申诉关键字');
    return mk(STATES.VERIFY_REQUIRED, '登录流程需要人工验证（短信/设备锁/申诉）', ev);
  }
  if (onebot.reachable && onebot.online === false) {
    ev.push('get_status.online=false');
    return mk(STATES.LOGIN_INVALID, 'OneBot 可达但登录态失效', ev);
  }
  if (qr.exists && Number.isFinite(qr.ageMs) && qr.ageMs <= staleQrMs) {
    ev.push(`二维码存在且较新（${Math.round(qr.ageMs / 1000)}s）`);
    return mk(STATES.QR_WAITING, '检测到待扫码二维码', ev);
  }
  if (port.listening) {
    ev.push(`端口 ${port.host}:${port.port} 在监听但 OneBot 无响应`);
    return mk(STATES.WS_HUNG, '端口已监听、OneBot 未就绪（可能登录中/卡死）', ev);
  }
  if (napcatProc.running === false) {
    ev.push('未发现 NapCat 进程');
    return mk(STATES.NAPCAT_DOWN, 'NapCat 进程未运行且端口未监听', ev);
  }
  if (napcatProc.running === true && !port.listening) {
    ev.push(`NapCat 进程在跑 (PID ${(napcatProc.pids || []).join(',') || '?'}) 但 OneBot 端口未监听`);
    return mk(STATES.NAPCAT_NO_WS, 'NapCat 在跑但 OneBot 未就绪（可能卡在登录/二维码已失效），需要重启出码', ev);
  }
  ev.push('证据不足');
  return mk(STATES.UNKNOWN, '无法判定（进程探测不可用或登录中）', ev);
}

function mk(state, reason, evidence) {
  return { state, reason, evidence, meta: STATE_META[state], at: new Date().toISOString() };
}

/** 哪些状态需要人工介入，禁止自动重试（防止把账号从"被踢"推进"被封"） */
export function needsManual(state) {
  return state === STATES.RISK_LIMITED || state === STATES.VERIFY_REQUIRED || state === STATES.MANUAL_TAKEOVER;
}

/** 哪些状态触发"重启 NapCat" */
export function wantsRestart(state) {
  return state === STATES.SUSPECT_OFFLINE || state === STATES.LOGIN_INVALID || state === STATES.WS_HUNG || state === STATES.NAPCAT_NO_WS;
}

/** 哪些状态触发"自动扫码自愈" */
export function wantsHeal(state) {
  return state === STATES.QR_WAITING;
}

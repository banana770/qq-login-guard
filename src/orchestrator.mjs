// orchestrator.mjs — 守护主循环：探测 → 归因 → 决策 → 动作 → 审计
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { nowIso, pidAlive, sleep, fileStat, tcpProbe } from './util.mjs';
import { createLogger } from './logger.mjs';
import { resolveProfile } from './config.mjs';
import { collectProbe } from './probe.mjs';
import { classify, needsManual, wantsHeal, wantsRestart, STATES, STATE_META } from './state.mjs';
import { RuntimeStore, gate } from './store.mjs';
import { createDriver } from './drivers/index.mjs';
import { killNapcat, deleteOldQr, launchNapcat, waitForNapcatUp, waitForOnline } from './actions.mjs';
import { notify } from './notify.mjs';
import { createStatusServer } from './server.mjs';

export class Guard {
  constructor({ config, configDir, filePath = '' }) {
    this.config = config;
    this.configDir = configDir;
    this.filePath = filePath;
    this.profileIndex = 0;
    this.mode = 'attach';
    this.running = false;
    this.startedAt = nowIso();
    this.events = [];
    this.lastProbe = null;
    this.lastAction = null;
    this.lastError = '';
    this.stateSince = nowIso();
    this.currentState = STATES.UNKNOWN;
    this.server = null;
    this.timers = [];
  }

  resolve() {
    return resolveProfile(this.config, this.configDir, this.profileIndex);
  }

  logEvent(level, msg, data) {
    const rec = { ts: nowIso(), level, msg, data };
    this.events.push(rec);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    const fn = level === 'error' ? this.logger.error : level === 'warn' ? this.logger.warn : this.logger.info;
    fn(msg, data);
  }

  async init({ mode = 'attach', dryRunOverride = undefined } = {}) {
    const resolved = this.resolve();
    this.resolved = resolved;
    this.mode = mode;
    await mkdir(resolved.dataDir, { recursive: true });
    this.logger = createLogger({
      level: this.config.logging?.level || 'info',
      jsonlPath: this.config.logging?.jsonl === false ? '' : path.join(resolved.dataDir, 'audit.jsonl'),
      prefix: `guard:${resolved.profile.id}`,
    });
    this.store = new RuntimeStore(resolved.dataDir, resolved.profile.id);
    await this.store.load();
    if (typeof dryRunOverride === 'boolean') this.resolved.profile.safety.dryRun = dryRunOverride;
    this.driver = createDriver({
      resolved: this.resolved,
      logger: this.logger,
      profileName: this.resolved.profile.id,
      dataDir: resolved.dataDir,
      notifyFn: (kind, payload) => this.notify(kind, payload),
    });
    await this.acquireLock();
    return this;
  }

  get dryRun() { return this.resolved.profile.safety?.dryRun !== false; }

  async acquireLock() {
    const lockPath = path.join(this.resolved.dataDir, 'guard.lock');
    try {
      const raw = await readFile(lockPath, 'utf8');
      const prev = JSON.parse(raw);
      if (prev?.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
        throw new Error(`已有守护进程在运行 (PID ${prev.pid}, 启动于 ${prev.startedAt})。如确认已死，请删除 ${lockPath}`);
      }
    } catch (e) {
      if (/已有守护进程/.test(String(e?.message))) throw e;
    }
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: this.startedAt, profileId: this.resolved.profile.id }, null, 2));
    this.lockPath = lockPath;
  }

  async releaseLock() {
    try { if (this.lockPath && existsSync(this.lockPath)) await unlink(this.lockPath); } catch {}
  }

  async notify(kind, payload) {
    const channels = this.resolved.profile.notify?.channels || [];
    if (!channels.length) {
      this.logEvent('warn', `[notify:${kind}] ${payload?.name ?? this.resolved.profile.id} ${payload?.extra ?? ''}`);
      return;
    }
    const r = await notify(channels, kind, { name: this.resolved.profile.id, ...payload }, this.logger);
    this.logEvent('info', `通知已发送: ${kind}`, { results: r.results });
  }

  snapshot() {
    const rt = this.store.state;
    const qr = this.lastProbe?.qr;
    return {
      ok: true,
      product: 'qq-login-guard',
      version: '0.1.0',
      mode: this.mode,
      dryRun: this.dryRun,
      running: this.running,
      pid: process.pid,
      startedAt: this.startedAt,
      profile: {
        id: this.resolved.profile.id,
        account: this.resolved.account,
        wsUrl: this.resolved.wsUrl,
        napcatDir: this.resolved.napcatDir,
        qrPath: this.resolved.qrPath,
        deviceDriver: this.resolved.profile.device?.driver || 'manual',
      },
      state: this.currentState,
      stateLabel: STATE_META[this.currentState]?.label ?? this.currentState,
      stateSince: this.stateSince,
      reason: this.lastClassify?.reason ?? '',
      evidence: this.lastClassify?.evidence ?? [],
      counts: {
        offlineStrikes: rt.offlineStrikes,
        restartsLastHour: this.store.countRestartsLastHour(),
        healsLastDay: this.store.countHealsLastDay(),
        manualUntil: rt.manualUntil,
      },
      policy: this.resolved.profile.policy,
      lastProbe: this.lastProbe ? {
        ts: this.lastProbe.ts,
        online: this.lastProbe.onebot?.online,
        reachable: this.lastProbe.onebot?.reachable,
        fakeAlive: this.lastProbe.onebot?.fakeAlive,
        portListening: this.lastProbe.port?.listening,
        qr: qr ? { exists: qr.exists, ageMs: qr.ageMs, md5: qr.md5?.slice(0, 8) } : null,
        log: this.lastProbe.log ? { exists: this.lastProbe.log.exists, risk: this.lastProbe.log.risk, verify: this.lastProbe.log.verify, kicked: this.lastProbe.log.kicked } : null,
      } : null,
      lastAction: this.lastAction,
      lastError: this.lastError,
      events: this.events.slice(-30),
    };
  }

  async tick() {
    const probe = await collectProbe(this.resolved);
    this.lastProbe = probe;
    const cls = classify(probe, { staleQrMs: this.resolved.profile.policy?.staleQrMs ?? 240000 });
    this.lastClassify = cls;
    const rt = this.store.state;
    const prevState = this.currentState;
    if (cls.state !== prevState) {
      this.currentState = cls.state;
      this.stateSince = nowIso();
      this.logEvent('info', `状态: ${prevState} → ${cls.state}（${cls.reason}）`, { evidence: cls.evidence });
    }
    rt.lastState = cls.state;
    rt.lastStateAt = nowIso();

    // 1) 在线：清计数；QR_WAITING→ONLINE 已由 doHeal 播报过，不再重复通知
    if (cls.state === STATES.ONLINE) {
      rt.offlineStrikes = 0;
      if (prevState !== STATES.ONLINE && prevState !== STATES.QR_WAITING && (rt.lastHealAt || rt.lastRestartAt)) {
        await this.notify('HEAL_OK', { extra: '已恢复在线' });
      }
      this.store.clearManual();
      await this.store.save();
      return cls;
    }

    // 2) 需人工：停止自动重试（README 坑点 15 的教训：乱重试会加重风控）
    if (needsManual(cls.state)) {
      const pol = this.resolved.profile.policy ?? {};
      const manualMs = pol.manualPauseMs ?? 30 * 60 * 1000;
      if (!this.store.inManual()) {
        this.store.setManual(manualMs, cls.reason);
        await this.notify(cls.state === STATES.RISK_LIMITED ? 'RISK_LIMITED' : 'VERIFY_REQUIRED', { extra: cls.reason });
      }
      await this.store.save();
      return cls;
    }

    // 3) 需要重启
    if (wantsRestart(cls.state)) {
      rt.offlineStrikes = (rt.offlineStrikes || 0) + 1;
      const strikesNeeded = this.resolved.profile.policy?.offlineStrikes ?? 3;
      this.logEvent('warn', `离线判定 ${rt.offlineStrikes}/${strikesNeeded}（${cls.state}）`);
      if (rt.offlineStrikes >= strikesNeeded) {
        const g = gate(rt, this.resolved.profile, 'restart');
        if (!g.allow) {
          this.logEvent('warn', `重启被拦截：${g.reason}`);
          rt.offlineStrikes = 0;
        } else if (this.dryRun) {
          this.logEvent('info', `[dry-run] 将执行：重启 NapCat（${cls.reason}）`);
          this.lastAction = { kind: 'restart', dryRun: true, at: nowIso() };
          rt.offlineStrikes = 0;
        } else {
          await this.doRestart(cls.reason);
          rt.offlineStrikes = 0;
        }
      }
      await this.store.save();
      return cls;
    }

    // 4) 有待扫码二维码 → 自愈
    if (wantsHeal(cls.state)) {
      const g = gate(rt, this.resolved.profile, 'heal');
      if (!g.allow) {
        this.logEvent('warn', `自愈被拦截：${g.reason}`);
        await this.store.save();
        return cls;
      }
      if (this.dryRun) {
        this.logEvent('info', `[dry-run] 将执行：自动扫码自愈（二维码 ${Math.round((probe.qr?.ageMs ?? 0) / 1000)}s 前生成，驱动=${this.driver.name}）`);
        this.lastAction = { kind: 'heal', dryRun: true, at: nowIso() };
        await this.store.save();
        return cls;
      }
      await this.doHeal(cls);
      await this.store.save();
      return cls;
    }

    // 5) NapCat 没运行
    if (cls.state === STATES.NAPCAT_DOWN) {
      const launchEnabled = this.resolved.profile.napcat?.launch?.enabled;
      if (!launchEnabled || this.mode === 'follow') {
        this.logEvent('warn', 'NapCat 未运行（未启用 launch 或 follow 模式），无法自动拉起');
      } else if (this.dryRun) {
        this.logEvent('info', '[dry-run] 将执行：拉起 NapCat');
        this.lastAction = { kind: 'launch', dryRun: true, at: nowIso() };
      } else {
        const l = await launchNapcat(this.resolved, this.logger);
        this.lastAction = { kind: 'launch', ...l, at: nowIso() };
        if (l.ok) await waitForNapcatUp(this.resolved, this.resolved.profile.napcat?.launch?.waitMs ?? 90000);
      }
    }

    await this.store.save();
    return cls;
  }

  async doRestart(reason) {
    const launchEnabled = this.resolved.profile.napcat?.launch?.enabled && this.mode !== 'follow';
    if (!launchEnabled) {
      // 不能拉起就不要杀：否则会把 NapCat 弄成"死着没人管"。转人工 + 长暂停。
      const manualMs = this.resolved.profile.policy?.manualPauseMs ?? 30 * 60 * 1000;
      this.store.setManual(manualMs, `需要重启 NapCat（${reason}），但 launch 未启用`);
      this.store.markRestart();
      this.lastAction = { kind: 'restart', skipped: true, reason: 'launch.disabled（未杀进程）', at: nowIso() };
      this.logEvent('warn', '需要重启 NapCat 但 launch 未启用，已转人工（未杀进程）。把 napcat.launch.enabled 打开或手动重启。');
      await this.notify('RESTARTED', { extra: `需要人工重启 NapCat（${reason}）：launch 未启用` });
      return;
    }
    this.logEvent('warn', `重启 NapCat：${reason}`);
    this.store.markRestart();
    const killed = await killNapcat(this.resolved, this.logger);
    await deleteOldQr(this.resolved);
    let launched = { ok: false, reason: 'launch.disabled' };
    if (launchEnabled) {
      launched = await launchNapcat(this.resolved, this.logger);
      await waitForNapcatUp(this.resolved, this.resolved.profile.napcat?.launch?.waitMs ?? 90000);
    }
    this.lastAction = { kind: 'restart', reason, killed, launched, at: nowIso() };
    await this.notify('RESTARTED', { extra: `原因=${reason}; killed=${killed.killed.length}; launched=${launched.ok}` });
  }

  async doHeal(cls) {
    this.logEvent('info', `开始自动扫码自愈（驱动=${this.driver.name}）`);
    this.store.markHeal();
    try {
      // 二维码有 TTL（约 2 分钟）。如果当前码已经太旧，先等 NapCat 刷新出新码再推，
      // 避免"推了一张快过期的码→扫码成功但确认失败"。
      const maxAge = this.resolved.profile.policy?.qrPushMaxAgeMs ?? 60000;
      const qrStat = await fileStat(this.resolved.qrPath);
      if (qrStat.exists) {
        const ageMs = Date.now() - qrStat.mtimeMs;
        this.logEvent('info', `二维码年龄 ${Math.round(ageMs / 1000)}s（推码上限 ${Math.round(maxAge / 1000)}s）`);
        if (ageMs > maxAge) {
          const before = qrStat.mtimeMs;
          let refreshed = false;
          for (let i = 0; i < 40; i++) {
            await sleep(1500);
            const cur = await fileStat(this.resolved.qrPath);
            if (cur.exists && cur.mtimeMs > before) { refreshed = true; break; }
          }
          this.logEvent(refreshed ? 'info' : 'warn', refreshed ? '已等到 NapCat 刷新二维码' : '等待新二维码超时，仍使用当前码（可能失败）');
        }
      }
      const res = await this.driver.heal({ qrPath: this.resolved.qrPath, profileName: this.resolved.profile.id });
      const verify = await waitForOnline(this.resolved, { timeoutMs: 45000 });
      if (verify.ok) {
        this.logEvent('info', `自愈成功，${Math.round(verify.waitedMs / 1000)}s 后恢复在线`);
        this.lastAction = { kind: 'heal', ok: true, res, verify, at: nowIso() };
        await this.driver.cleanup?.();
        await this.notify('HEAL_OK', { extra: `${Math.round(verify.waitedMs / 1000)}s` });
      } else {
        this.logEvent('error', '自愈后仍未恢复在线', { detail: verify });
        this.lastAction = { kind: 'heal', ok: false, res, verify, at: nowIso() };
        this.lastError = 'heal_verify_failed';
        await this.driver.cleanup?.();
        await this.notify('HEAL_FAIL', { extra: '扫码流程执行后未恢复在线（可能二维码过期/UI 变化/账号被限制）' });
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      this.logEvent('error', `自愈失败：${msg}`, { stack: String(e?.stack || '').slice(0, 500) });
      this.lastError = msg;
      this.lastAction = { kind: 'heal', ok: false, error: msg, at: nowIso() };
      await this.driver.cleanup?.().catch(() => {});
      await this.notify('HEAL_FAIL', { extra: msg });
    }
  }

  async start({ server = true } = {}) {
    this.running = true;
    if (this.mode === 'embed' && this.resolved.profile.napcat?.launch?.enabled) {
      const up = await fileStat(this.resolved.qrPath);
      const portOpen = await tcpProbe('127.0.0.1', Number(new URL(this.resolved.wsUrl).port) || 80, 800);
      if (!portOpen && !up.exists) {
        this.logEvent('info', 'embed 模式：先拉起 NapCat，再由守护接管');
        await launchNapcat(this.resolved, this.logger);
      }
    }
    if (server && this.config.server?.enabled !== false) {
      try {
        this.server = await createStatusServer({
          guard: this,
          config: this.config,
          configDir: this.configDir,
          filePath: this.filePath,
          logger: this.logger,
          host: this.config.server?.host || '127.0.0.1',
          port: this.config.server?.port ?? 39100,
          token: this.config.server?.token || '',
        });
        this.logEvent('info', `状态服务已启动: http://${this.config.server.host || '127.0.0.1'}:${this.config.server.port ?? 39100}（/status /events /setup）`);
      } catch (e) {
        this.logEvent('error', `状态服务启动失败（继续守护）: ${String(e?.message || e)}`);
      }
    }
    await this.notify('GUARD_STARTED', { extra: `mode=${this.mode} dryRun=${this.dryRun}` });
    const interval = Math.max(5000, this.resolved.profile.policy?.checkIntervalMs ?? 30000);
    await this.tick().catch((e) => this.logEvent('error', `首轮探测失败: ${String(e?.message || e)}`));
    while (this.running) {
      await sleep(interval);
      if (!this.running) break;
      try { await this.tick(); } catch (e) { this.logEvent('error', `tick 失败: ${String(e?.message || e)}`); }
    }
  }

  async stop() {
    this.running = false;
    try { await this.server?.close(); } catch {}
    await this.releaseLock();
    await this.store?.save();
  }
}

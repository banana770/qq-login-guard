// store.mjs — 运行时状态与计数持久化（熔断依据）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { nowIso, safeJson } from './util.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export function emptyRuntime(profileId = 'main') {
  return {
    profileId,
    updatedAt: nowIso(),
    offlineStrikes: 0,
    lastState: '',
    lastStateAt: '',
    lastRestartAt: 0,
    lastHealAt: 0,
    restarts: [],
    heals: [],
    manualUntil: 0,
    lastQrMd5: '',
    lastQrSeenAt: 0,
    lastError: '',
  };
}

export class RuntimeStore {
  constructor(dataDir, profileId) {
    this.file = path.join(dataDir, `runtime.${profileId}.json`);
    this.state = emptyRuntime(profileId);
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = safeJson(raw, null);
      if (parsed && typeof parsed === 'object') this.state = { ...emptyRuntime(this.state.profileId), ...parsed };
    } catch { /* 首次运行 */ }
    this.prune();
    return this.state;
  }

  async save() {
    this.state.updatedAt = nowIso();
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2));
    } catch { /* 持久化失败不阻断 */ }
  }

  prune(now = Date.now()) {
    this.state.restarts = (this.state.restarts || []).filter((t) => now - t < HOUR);
    this.state.heals = (this.state.heals || []).filter((t) => now - t < DAY);
    return this.state;
  }

  countRestartsLastHour() { this.prune(); return this.state.restarts.length; }
  countHealsLastDay() { this.prune(); return this.state.heals.length; }

  markRestart() { this.prune(); this.state.restarts.push(Date.now()); this.state.lastRestartAt = Date.now(); }
  markHeal() { this.prune(); this.state.heals.push(Date.now()); this.state.lastHealAt = Date.now(); }

  setManual(ms, reason = '') {
    this.state.manualUntil = Date.now() + ms;
    this.state.lastError = reason;
  }
  inManual(now = Date.now()) { return this.state.manualUntil > now; }
  clearManual() { this.state.manualUntil = 0; }
}

/** 兼容两种入参：RuntimeStore 实例，或裸 runtime 状态对象（便于单测与宿主直接传快照） */
function asRuntime(input) {
  if (input && typeof input.prune === 'function' && typeof input.countRestartsLastHour === 'function') return input;
  const rt = input ?? emptyRuntime();
  rt.restarts = rt.restarts || [];
  rt.heals = rt.heals || [];
  rt.prune = (now = Date.now()) => {
    rt.restarts = rt.restarts.filter((t) => now - t < HOUR);
    rt.heals = rt.heals.filter((t) => now - t < DAY);
    return rt;
  };
  rt.countRestartsLastHour = () => { rt.prune(); return rt.restarts.length; };
  rt.countHealsLastDay = () => { rt.prune(); return rt.heals.length; };
  rt.inManual = (now = Date.now()) => Number(rt.manualUntil || 0) > now;
  return rt;
}

/** 策略门禁：返回 { allow, reason }（熔断/冷却/每日上限/人工接管） */
export function gate(runtimeInput, profile, kind, now = Date.now()) {
  const runtime = asRuntime(runtimeInput);
  const pol = profile.policy ?? {};
  runtime.prune(now);
  if (runtime.inManual(now)) {
    const left = Math.round((runtime.manualUntil - now) / 1000);
    return { allow: false, reason: `人工接管中，剩余 ${left}s（原因：${runtime.lastError || '需人工'}）` };
  }
  if (kind === 'restart') {
    if (pol.cooldownMs && runtime.lastRestartAt && now - runtime.lastRestartAt < pol.cooldownMs) {
      return { allow: false, reason: `重启冷却中（${Math.round((pol.cooldownMs - (now - runtime.lastRestartAt)) / 1000)}s）` };
    }
    if (Number.isFinite(pol.maxRestartPerHour) && runtime.countRestartsLastHour() >= pol.maxRestartPerHour) {
      return { allow: false, reason: `每小时重启已达上限 ${pol.maxRestartPerHour} 次` };
    }
  }
  if (kind === 'heal') {
    if (pol.cooldownMs && runtime.lastHealAt && now - runtime.lastHealAt < pol.cooldownMs) {
      return { allow: false, reason: `自愈冷却中（${Math.round((pol.cooldownMs - (now - runtime.lastHealAt)) / 1000)}s）` };
    }
    if (Number.isFinite(pol.maxAutoHealPerDay) && runtime.countHealsLastDay() >= pol.maxAutoHealPerDay) {
      return { allow: false, reason: `每日自愈已达上限 ${pol.maxAutoHealPerDay} 次` };
    }
  }
  return { allow: true, reason: '' };
}

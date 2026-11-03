// state.test.mjs — 状态归因单测（不需要真实 NapCat）
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, STATES, needsManual, wantsHeal, wantsRestart } from '../src/state.mjs';

const base = {
  onebot: { reachable: false, online: null },
  port: { listening: false, host: '127.0.0.1', port: 30011 },
  qr: { exists: false, ageMs: null },
  log: { exists: false, risk: false, verify: false, kicked: false },
  process: { available: true, processes: [{ name: 'NapCatWinBootMain.exe', running: false, pids: [] }] },
};

const withPatch = (patch) => ({
  ...base,
  ...patch,
  onebot: { ...base.onebot, ...(patch.onebot || {}) },
  port: { ...base.port, ...(patch.port || {}) },
  qr: { ...base.qr, ...(patch.qr || {}) },
  log: { ...base.log, ...(patch.log || {}) },
});

test('在线：reachable + online + 深度探测通过 → ONLINE', () => {
  const c = classify(withPatch({ onebot: { reachable: true, online: true, fakeAlive: true }, port: { listening: true } }));
  assert.equal(c.state, STATES.ONLINE);
  assert.equal(needsManual(c.state), false);
});

test('幽灵在线：online 但深度探测失败 → SUSPECT_OFFLINE', () => {
  const c = classify(withPatch({ onebot: { reachable: true, online: true, fakeAlive: false }, port: { listening: true } }));
  assert.equal(c.state, STATES.SUSPECT_OFFLINE);
  assert.equal(wantsRestart(c.state), true);
});

test('风控关键字优先于二维码等待：RISK_LIMITED，且不许自动重试', () => {
  const c = classify(withPatch({
    onebot: { reachable: true, online: false },
    port: { listening: true },
    qr: { exists: true, ageMs: 5000 },
    log: { exists: true, risk: true, fresh: true },
  }));
  assert.equal(c.state, STATES.RISK_LIMITED);
  assert.equal(needsManual(c.state), true);
  assert.equal(wantsHeal(c.state), false);
  assert.equal(wantsRestart(c.state), false);
});

test('验证码/设备锁 → VERIFY_REQUIRED（人工）', () => {
  const c = classify(withPatch({ log: { exists: true, verify: true, fresh: true }, qr: { exists: true, ageMs: 1000 } }));
  assert.equal(c.state, STATES.VERIFY_REQUIRED);
  assert.equal(needsManual(c.state), true);
});

test('二维码新鲜 + 未在线 → QR_WAITING', () => {
  const c = classify(withPatch({ qr: { exists: true, ageMs: 30_000 }, port: { listening: false } }));
  assert.equal(c.state, STATES.QR_WAITING);
  assert.equal(wantsHeal(c.state), true);
});

test('二维码过旧 → 不算 QR_WAITING', () => {
  const c = classify(withPatch({ qr: { exists: true, ageMs: 10 * 60_000 } }), { staleQrMs: 240000 });
  assert.notEqual(c.state, STATES.QR_WAITING);
});

test('端口在但 OneBot 无响应 → WS_HUNG', () => {
  const c = classify(withPatch({ port: { listening: true } }));
  assert.equal(c.state, STATES.WS_HUNG);
  assert.equal(wantsRestart(c.state), true);
});

test('进程不在且端口不监听 → NAPCAT_DOWN', () => {
  const c = classify(withPatch({}));
  assert.equal(c.state, STATES.NAPCAT_DOWN);
});

test('进程探测不可用且无其它证据 → UNKNOWN（不要瞎重启）', () => {
  const c = classify(withPatch({ process: { available: false, processes: [{ name: 'NapCatWinBootMain.exe', running: null, pids: [] }] } }));
  assert.equal(c.state, STATES.UNKNOWN);
  assert.equal(wantsRestart(c.state), false);
});

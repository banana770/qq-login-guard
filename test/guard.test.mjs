// guard.test.mjs — 配置/熔断单测
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, validateConfig, resolveProfile } from '../src/config.mjs';
import { RuntimeStore, emptyRuntime, gate } from '../src/store.mjs';

test('默认配置可校验通过', () => {
  const cfg = normalizeConfig({});
  const v = validateConfig(cfg);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('默认设备驱动是 MuMu 全自动（不是 manual）', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.profiles[0].device.driver, 'mumu-adb');
});

test('非 ws 地址被拒绝', () => {
  const cfg = normalizeConfig({ profiles: [{ napcat: { wsUrl: 'http://x' } }] });
  const v = validateConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /wsUrl/.test(e)));
});

test('相对路径按 NapCat 目录解析（跨平台）', () => {
  // 用当前平台的绝对路径，避免 Linux CI 上把 Windows 盘符当成相对路径
  const base = path.resolve(os.tmpdir(), 'qlg-proj');
  const napcatDir = path.join(base, 'NapCat.Shell');
  const cfg = normalizeConfig({ profiles: [{ napcat: { dir: napcatDir, qrPath: 'cache/qrcode.png', logPath: 'a.log' } }] });
  const r = resolveProfile(cfg, base, 0);
  assert.equal(r.napcatDir, path.normalize(napcatDir));
  assert.equal(r.qrPath, path.join(napcatDir, 'cache', 'qrcode.png'));
  assert.equal(r.logPath, path.join(napcatDir, 'a.log'));
});

test('熔断：每小时重启上限生效', async () => {
  const dir = path.join(os.tmpdir(), `qlg-test-${Date.now()}`);
  const store = new RuntimeStore(dir, 'test');
  await store.load();
  const pol = { policy: { maxRestartPerHour: 2, cooldownMs: 0 } };
  store.markRestart();
  store.markRestart();
  const g = gate(store.state, pol, 'restart');
  assert.equal(g.allow, false);
  assert.match(g.reason, /上限/);
});

test('熔断：每日自愈上限生效', async () => {
  const store = new RuntimeStore(path.join(os.tmpdir(), `qlg-test2-${Date.now()}`), 'test');
  await store.load();
  const pol = { policy: { maxAutoHealPerDay: 2, cooldownMs: 0 } };
  store.markHeal();
  store.markHeal();
  const g = gate(store.state, pol, 'heal');
  assert.equal(g.allow, false);
});

test('熔断：冷却时间生效', async () => {
  const store = new RuntimeStore(path.join(os.tmpdir(), `qlg-test3-${Date.now()}`), 'test');
  await store.load();
  store.markHeal();
  const g = gate(store.state, { policy: { maxAutoHealPerDay: 99, cooldownMs: 60000 } }, 'heal');
  assert.equal(g.allow, false);
  assert.match(g.reason, /冷却/);
});

test('人工接管期间所有动作被拒', async () => {
  const store = new RuntimeStore(path.join(os.tmpdir(), `qlg-test4-${Date.now()}`), 'test');
  await store.load();
  store.setManual(60_000, 'risk');
  assert.equal(store.inManual(), true);
  assert.equal(gate(store.state, { policy: { cooldownMs: 0, maxRestartPerHour: 99 } }, 'restart').allow, false);
});

test('超过 1 小时的重启记录会被清理', () => {
  const rt = emptyRuntime('x');
  rt.restarts = [Date.now() - 2 * 3600 * 1000, Date.now()];
  const store = new RuntimeStore(path.join(os.tmpdir(), `qlg-${Date.now()}`), 'x');
  store.state = rt;
  store.prune();
  assert.equal(store.state.restarts.length, 1);
});

test('拉起限速：每小时上限生效（防崩溃→拉起风暴）', async () => {
  const store = new RuntimeStore(path.join(os.tmpdir(), `qlg-test5-${Date.now()}`), 'test');
  await store.load();
  store.markLaunch();
  store.markLaunch();
  store.markLaunch();
  const g = gate(store.state, { policy: { maxLaunchPerHour: 3, launchCooldownMs: 0 } }, 'launch');
  assert.equal(g.allow, false);
  assert.match(g.reason, /拉起/);
});

test('拉起限速：冷却与连续失败转人工', async () => {
  const store = new RuntimeStore(path.join(os.tmpdir(), `qlg-test6-${Date.now()}`), 'test');
  await store.load();
  store.markLaunch();
  const cool = gate(store.state, { policy: { launchCooldownMs: 60000, maxLaunchPerHour: 99 } }, 'launch');
  assert.equal(cool.allow, false);
  assert.match(cool.reason, /冷却/);
  const store2 = new RuntimeStore(path.join(os.tmpdir(), `qlg-test7-${Date.now()}`), 'test2');
  await store2.load();
  store2.markLaunchFailure();
  store2.markLaunchFailure();
  store2.markLaunchFailure();
  const g2 = gate(store2.state, { policy: { maxLaunchFailures: 3, launchCooldownMs: 0, maxLaunchPerHour: 99 } }, 'launch');
  assert.equal(g2.allow, false);
  assert.match(g2.reason, /连续拉起失败/);
});

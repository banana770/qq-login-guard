// config.mjs — 配置加载 / 校验 / 路径解析
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFrom } from './util.mjs';

export const CONFIG_ENV = 'QQ_LOGIN_GUARD_CONFIG';

export const DEFAULT_CONFIG = {
  profiles: [
    {
      id: 'main',
      napcat: {
        wsUrl: 'ws://127.0.0.1:30011',
        tokenEnv: 'QQ_LOGIN_GUARD_TOKEN',
        token: '',
        account: '',
        dir: '',
        qrPath: 'cache/qrcode.png',
        logPath: 'napcat_hidden.log',
        launch: { enabled: false, background: true, hideWindows: false, cmd: 'cmd.exe', args: ['/c', 'launcher-user.bat', '{account}'], cwd: '', waitMs: 90000 },
      },
      device: {
        driver: 'mumu-adb',
        adb: {
          exe: '',
          host: '127.0.0.1',
          port: 16384,
          remotePic: '/storage/emulated/0/DCIM/Camera/qr_fresh.png',
          resolution: { width: 1080, height: 1920, adaptive: true },
          coldStartShortcut: '',
          qqPackage: 'com.tencent.mobileqq',
          qqActivity: 'com.tencent.mobileqq.activity.SplashActivity',
          qqLaunchIntent: '',
        },
      },
      policy: {
        checkIntervalMs: 30000,
        offlineStrikes: 3,
        cooldownMs: 180000,
        maxRestartPerHour: 3,
        maxAutoHealPerDay: 12,
        staleQrMs: 240000,
        qrPushMaxAgeMs: 60000,
        launchCooldownMs: 60000,
        maxLaunchPerHour: 3,
        maxLaunchFailures: 3,
        catchUpWindowMs: 1800000,
        manualPauseMs: 1800000,
      },
      notify: { channels: [] },
      safety: { dryRun: true, secureWipe: true, deleteBeyondOwnFiles: false },
    },
  ],
  server: { enabled: true, host: '127.0.0.1', port: 39100, token: '' },
  logging: { level: 'info', jsonl: true },
  dataDir: '',
};

export function findConfigFile(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env[CONFIG_ENV]) candidates.push(process.env[CONFIG_ENV]);
  candidates.push(
    path.resolve('qq-login-guard.config.json'),
    path.resolve('config.local.json'),
    path.resolve('config.json'),
    path.join(os.homedir(), '.qq-login-guard', 'config.json'),
  );
  for (const c of candidates) {
    if (c && existsSync(c)) return path.resolve(c);
  }
  return '';
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = isObject(v) ? merge(base[k] ?? {}, v) : v;
  return out;
}

export function normalizeConfig(raw) {
  const cfg = merge(DEFAULT_CONFIG, raw ?? {});
  if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) cfg.profiles = DEFAULT_CONFIG.profiles.map((p) => ({ ...p }));
  cfg.profiles = cfg.profiles.map((p, i) => {
    const merged = merge(DEFAULT_CONFIG.profiles[0], p ?? {});
    if (!merged.id) merged.id = `profile-${i + 1}`;
    return merged;
  });
  return cfg;
}

/** 解析出运行时需要的绝对路径（不写入原配置） */
export function resolveProfile(cfg, configDir, profileIndex = 0) {
  const p = cfg.profiles[profileIndex];
  const napcatDir = resolveFrom(configDir, p.napcat.dir || '');
  const qrPath = resolveFrom(napcatDir || configDir, p.napcat.qrPath || 'cache/qrcode.png');
  const logPath = p.napcat.logPath
    ? (path.isAbsolute(p.napcat.logPath) ? path.normalize(p.napcat.logPath) : resolveFrom(napcatDir || configDir, p.napcat.logPath))
    : '';
  const adbExe = p.device?.adb?.exe ? resolveFrom(configDir, p.device.adb.exe) : '';
  const shortcut = p.device?.adb?.coldStartShortcut ? resolveFrom(configDir, p.device.adb.coldStartShortcut) : '';
  const launchCwd = p.napcat.launch?.cwd ? resolveFrom(configDir, p.napcat.launch.cwd) : napcatDir;
  const dataDir = resolveFrom(configDir, cfg.dataDir || '.qq-login-guard');
  return {
    profile: p,
    configDir,
    dataDir,
    napcatDir,
    qrPath,
    logPath,
    adbExe,
    shortcut,
    launchCwd,
    wsUrl: p.napcat.wsUrl,
    token: resolveToken(p),
    account: String(p.napcat.account || ''),
  };
}

export function resolveToken(profile) {
  const envName = profile?.napcat?.tokenEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return profile?.napcat?.token || '';
}

export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) errors.push('profiles 不能为空');
  cfg.profiles.forEach((p, i) => {
    const tag = `profiles[${i}]`;
    if (!p.napcat?.wsUrl) errors.push(`${tag}.napcat.wsUrl 缺失`);
    else if (!/^wss?:\/\//i.test(p.napcat.wsUrl)) errors.push(`${tag}.napcat.wsUrl 必须是 ws:// 或 wss://`);
    if (!p.napcat?.dir) warnings.push(`${tag}.napcat.dir 为空：无法拉起 NapCat / 定位二维码（attach 模式仍可用）`);
    if (!p.napcat?.account) warnings.push(`${tag}.napcat.account 为空：无法做假死探针`);
    const driver = p.device?.driver;
    if (!['manual', 'mumu-adb', 'generic-adb'].includes(driver)) errors.push(`${tag}.device.driver 不支持: ${driver}`);
    if (driver !== 'manual') {
      if (!p.device?.adb?.exe) warnings.push(`${tag}.device.adb.exe 为空：将尝试从 PATH 查找 adb`);
      if (!p.device?.adb?.coldStartShortcut) warnings.push(`${tag}.device.adb.coldStartShortcut 为空：模拟器未运行时无法冷启动（可仅扫码）`);
    }
    const pol = p.policy ?? {};
    if (!(pol.checkIntervalMs >= 5000)) warnings.push(`${tag}.policy.checkIntervalMs 建议 >= 5000`);
    if (!(pol.maxRestartPerHour >= 0)) errors.push(`${tag}.policy.maxRestartPerHour 必须 >= 0`);
    if (!(pol.maxAutoHealPerDay >= 0)) errors.push(`${tag}.policy.maxAutoHealPerDay 必须 >= 0`);
  });
  const port = cfg.server?.port;
  if (port != null && !(Number.isInteger(port) && port > 0 && port < 65536)) errors.push('server.port 非法');
  return { ok: errors.length === 0, errors, warnings };
}

export async function loadConfig(explicitPath) {
  const file = findConfigFile(explicitPath);
  if (!file) {
    const cfg = normalizeConfig({});
    return { config: cfg, filePath: '', configDir: process.cwd(), isDefault: true };
  }
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return { config: normalizeConfig(raw), filePath: file, configDir: path.dirname(file), isDefault: false };
}

export async function saveConfig(filePath, cfg) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(path.resolve(filePath), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return path.resolve(filePath);
}

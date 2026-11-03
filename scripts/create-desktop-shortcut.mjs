// create-desktop-shortcut.mjs — 在桌面创建「QQ登录守护-配置页」快捷方式
// 双击 `1-创建桌面快捷方式.bat` 即可；也可以 node scripts/create-desktop-shortcut.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAT = path.join(ROOT, '0-打开配置页.bat');

function desktopDir() {
  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    path.join(os.homedir(), 'OneDrive', '桌面'),
    path.join(os.homedir(), '桌面'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const fallback = path.join(os.homedir(), 'Desktop');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

if (process.platform !== 'win32') {
  console.log('非 Windows 平台：请直接运行 ./打开配置页.sh，或在桌面创建指向它的快捷方式。');
  process.exit(0);
}

if (!existsSync(BAT)) {
  console.error(`找不到 ${BAT}`);
  process.exit(1);
}

const desktop = desktopDir();
const lnk = path.join(desktop, 'QQ登录守护-配置页.lnk');
const args = `/c ""${BAT}""`;

const ps = [
  '$w = New-Object -ComObject WScript.Shell',
  `$s = $w.CreateShortcut(${psQuote(lnk)})`,
  "$s.TargetPath = 'cmd.exe'",
  `$s.Arguments = ${psQuote(args)}`,
  `$s.WorkingDirectory = ${psQuote(ROOT)}`,
  "$s.IconLocation = '%SystemRoot%\\System32\\shell32.dll,221'",
  "$s.Description = 'QQ登录守护 - 打开配置页/状态页'",
  '$s.Save()',
].join('; ');

try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit', windowsHide: false });
  console.log(`\n✓ 已创建桌面快捷方式：${lnk}`);
  console.log('  双击它 = 启动配置页（若守护已在运行则直接打开网页）');
} catch (e) {
  console.error('创建失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
}

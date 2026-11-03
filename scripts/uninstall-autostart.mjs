// uninstall-autostart.mjs — 删除 qq-login-guard 的开机自启计划任务
import { execFileSync } from 'node:child_process';

const TASK_NAME = 'qq-login-guard';
if (process.platform !== 'win32') {
  console.log('非 Windows：删除 systemd 用户服务即可：');
  console.log('  systemctl --user disable --now qq-login-guard.service');
  console.log('  rm ~/.config/systemd/user/qq-login-guard.service');
  process.exit(0);
}

function sh(cmd, args) {
  try {
    return { ok: true, out: String(execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }) || '') };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || e.stderr)) || e) };
  }
}

const del = sh('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F']);
if (del.ok) {
  console.log(`✓ 已删除计划任务 ${TASK_NAME}`);
} else {
  console.log(`未删除（可能本来就不存在）：`);
  console.log(del.out.trim().slice(0, 800));
}

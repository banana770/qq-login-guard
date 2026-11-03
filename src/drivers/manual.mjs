// drivers/manual.mjs — 只出码通知，不驱动任何设备（无安卓环境的默认降级）
export function createManualDriver({ logger, notifyFn }) {
  return {
    name: 'manual',
    async description() { return '仅通知：把二维码交给人工扫描'; },
    async heal(ctx) {
      const text = `待扫码二维码：${ctx.qrPath || '(未找到二维码文件)'}`;
      logger?.warn(`[manual] ${text}`);
      await notifyFn?.('QR_WAITING', { name: ctx.profileName, extra: text });
      return { ok: false, reason: 'manual-required', detail: text };
    },
    async cleanup() { return { ok: true }; },
  };
}

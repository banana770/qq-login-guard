// drivers/index.mjs — 设备驱动工厂
import { createManualDriver } from './manual.mjs';
import { createAdbDriver } from './adb.mjs';

export function createDriver({ resolved, logger, profileName, dataDir, notifyFn }) {
  const kind = resolved.profile.device?.driver || 'manual';
  if (kind === 'manual') return createManualDriver({ logger, notifyFn });
  if (kind === 'mumu-adb' || kind === 'generic-adb') {
    return createAdbDriver({ resolved, logger, profileName, dataDir });
  }
  throw new Error(`未知设备驱动: ${kind}`);
}

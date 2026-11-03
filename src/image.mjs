// image.mjs — 二维码预处理：放大 + 白边（替代原 spec 里的 PowerShell 内联脚本，保留跨平台退路）
import { isWindows, run } from './util.mjs';

/**
 * 把二维码放大到 target×target 纯白画布（NearestNeighbor，保持黑白模块锐利）。
 * Windows: PowerShell System.Drawing（与原实现一致，实测可靠）
 * 其它平台: 尝试 ImageMagick（magick/convert），失败则原样返回并提示
 */
export async function upscaleQr(srcPath, dstPath, { target = 600, inner = 500, logger } = {}) {
  if (isWindows) {
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      `$bytes = [System.IO.File]::ReadAllBytes(${quote(srcPath)})`,
      '$ms = New-Object System.IO.MemoryStream(,$bytes)',
      '$src = [System.Drawing.Image]::FromStream($ms)',
      `$bmp = New-Object System.Drawing.Bitmap ${target}, ${target}`,
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
      '$g.Clear([System.Drawing.Color]::White)',
      `$g.DrawImage($src, ${Math.floor((target - inner) / 2)}, ${Math.floor((target - inner) / 2)}, ${inner}, ${inner})`,
      `$bmp.Save(${quote(dstPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose(); $bmp.Dispose(); $src.Dispose(); $ms.Dispose()',
    ].join('; ');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    const r = await run('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { timeoutMs: 20000 });
    if (r.code === 0) return { ok: true, engine: 'powershell', dstPath };
    logger?.warn('PowerShell 放大失败，尝试 ImageMagick', { stderr: (r.stderr || '').slice(0, 200) });
  }
  for (const tool of ['magick', 'convert']) {
    const args = tool === 'magick'
      ? [srcPath, '-filter', 'point', '-resize', `${inner}x${inner}`, '-background', 'white', '-gravity', 'center', '-extent', `${target}x${target}`, dstPath]
      : [srcPath, '-filter', 'point', '-resize', `${inner}x${inner}`, '-background', 'white', '-gravity', 'center', '-extent', `${target}x${target}`, dstPath];
    const r = await run(tool, args, { timeoutMs: 20000 });
    if (r.code === 0) return { ok: true, engine: tool, dstPath };
  }
  logger?.warn('未找到可用的图片放大工具，将直接使用原图（可能被相册过滤）');
  return { ok: false, engine: 'none', dstPath: srcPath, reason: 'no-image-tool' };
}

function quote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

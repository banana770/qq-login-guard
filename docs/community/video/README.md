# qq-login-guard 介绍视频（可直接使用）

本目录是**已制作完成的介绍片**及其可重建的源文件。

## 成品

| 文件 | 说明 |
|---|---|
| `qq-login-guard-intro.mp4` | 成片：1920×1080 / 30fps / H.264 + AAC，时长 **6:37**，旁白+字幕+完整免责声明 |
| `qq-login-guard-intro.srt` | 字幕文件（UTF-8，可用于平台外挂字幕） |
| `thumbnail.jpg` | 封面帧（开场页） |
| `slides/00.png` … `15.png` | 16 张幻灯片（PNG） |

> 视频也上传到了 GitHub Release v0.1.0 的 Assets 里，可直接下载。

## 源文件（可重建）

| 文件 | 作用 |
|---|---|
| `slides.html` | 16 页幻灯片（HTML/CSS/JS，`#N` 切换第 N 页） |
| `script.json` | 每页的章节标签与字幕 |
| `narration.json` | 每页旁白文案（Windows SAPI 中文语音合成用） |
| `slides/` | 渲染出的 PNG 幻灯片 |

**旁白**：Windows SAPI `Microsoft Huihui Desktop`（zh-CN）；换真人配音时，按 `qq-login-guard-intro.srt` 的时间轴替换音轨即可。

## 重建方法（Windows）

1. 渲染幻灯片：Chrome headless 截图
   ```
   chrome --headless=new --window-size=1920,1080 --screenshot=slides/00.png "file:///.../slides.html#0"
   ```
   （16 页循环 `#0`…`#15`）
2. 合成旁白：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1
   ```
   （读取 `narration.json`，输出 `audio/00.wav`…`audio/15.wav`）
3. 拼装视频：每页 `ffmpeg -loop 1 -i slides/NN.bmp -i audio/NN.wav -af apad -t <旁白+0.6s> …`
   再 `ffmpeg -f concat -safe 0 -i concat.txt -c copy qq-login-guard-intro.mp4`。
   （本机 ffmpeg 构建缺少 PNG 解码器，所以中间先把 PNG 转成 BMP，见 `png2bmp.ps1`）

> 所有画面文字均来自仓库 README / docs；数字（46 秒、约 5 分钟）来自 README 的实测记录。
> 视频中的配置页截图是示例数据；**真实账号、token、二维码不得出现在任何发布版本里**。

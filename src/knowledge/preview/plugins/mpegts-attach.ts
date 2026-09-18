/**
 * mpegts.js 的接线层（FLV / MPEG-TS 播放）。
 *
 * 为什么单独一个文件：mpegts.js 只在打开 FLV/TS 文件时才 `import()`（按需加载），
 * 放在 media.ts 里会让它进媒体 chunk 的静态分析图；类型也只在这里需要。
 *
 * 与 hls.js 的 kb:// loader 同思路：**字节全部来自知识库本地**（这里直接 blob URL，
 * mpegts.js 只从 URL 读字节），不碰网络；`enableWorker: false` —— 它的 worker 里
 * 没有我们的读取通道，主线程 demux 对预览场景足够。
 */

import mpegts from "mpegts.js";

export type MpegtsContainer = "flv" | "mpegts";

/**
 * 挂一个 mpegts.js 播放器；致命错误交给 `onFatal`（与 hls.js 分支同一套降级口径）。
 * `enableWorker: false`：worker 里没有我们的本地读取通道（与 hls.js 的 kb:// loader 同理）。
 */
export async function attachMpegts(
  video: HTMLVideoElement,
  url: string,
  container: MpegtsContainer,
  onFatal: (message: string) => void,
): Promise<() => void> {
  if (!mpegts.isSupported()) {
    onFatal("当前 WebView 不支持 MSE，无法播放这种流（请用默认应用打开）");
    return () => {};
  }
  const player = mpegts.createPlayer({ type: container, url, isLive: false });
  player.attachMediaElement(video);
  player.load();
  player.on(mpegts.Events.ERROR, (_type: string, data: { fatal?: boolean; details?: string }) => {
    if (data.fatal) onFatal(`播放失败（${data.details ?? "demux/解码错误"}）——编码可能不被支持，请用默认应用打开`);
  });
  return () => {
    player.unload();
    player.destroy();
  };
}

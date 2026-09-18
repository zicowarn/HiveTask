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
  // ⚠️ mpegts.js 的 error 数据**没有** `fatal` 字段（整个 dist 0 处命中，那是 hls.js 的形状）——
  // 照搬 hls.js 的 `if (data.fatal)` 会永不触发：FLV 里是不支持的编码（如录屏的 Screen Video +
  // ADPCM，用户实测样本）时 demux 一直报 CodecUnsupported，界面干等无反馈。mpegts.js 的约定是
  // **走到 ERROR 事件即不可恢复**（可恢复的在内部自动重试、不 emit），所以收到就降级。
  let failed = false;
  player.on(mpegts.Events.ERROR, (type: string, data: { detail?: string; info?: string }) => {
    if (failed) return;
    failed = true;
    const detail = data.detail ?? data.info ?? type;
    onFatal(`播放失败（${detail}）——编码可能不被支持，请用默认应用打开`);
    player.unload();
    player.destroy();
  });
  // 还有一种干等：demux 不报错、但也出不来初始化段（readyState 一直 0）。超时视为失败，
  // 给明确反馈而不是无限转圈（play() 由用户点，loadedmetadata 前不消费任何字节）。
  const watchdog = window.setTimeout(() => {
    if (failed || video.readyState >= 1) return;
    failed = true;
    onFatal("播放初始化超时——编码可能不被支持，请用默认应用打开");
    player.unload();
    player.destroy();
  }, 10_000);
  return () => {
    window.clearTimeout(watchdog);
    if (!failed) {
      player.unload();
      player.destroy();
    }
  };
}

/**
 * 音频 / 视频 / 歌词（LRC）预览。
 *
 * - **音视频**：用 WebView 原生 `<audio>`/`<video>` 播放**本地 blob**（不经网络）；
 *   播放器下方给一条元信息（时长 / 分辨率 / 体积），中文标题不截断；
 * - **HLS（m3u8）**：播放列表与分片都用知识库内的文件，**自定义 loader 走 `kb://` 虚拟协议**
 *   读字节 —— 不用它的默认 XHR（那会去请求网络，离线必炸）；
 * - **LRC**：解析 `[mm:ss.xx]` 时间标签与元信息标签，正文按 OFV 的两种视图（纯净 / 带时间）切换。
 *
 * 范围说明（如实标注）：DRM、加密流、`wmv/flv/rm` 这类浏览器不认的编码无法解码 ——
 * 这些一律落到「用默认应用打开」，不假装能放。
 */
import type { PreviewContext, PreviewInstance } from "../registry";
import { mediaInfoLine, parseAudioInfo, parseVideoInfo } from "./media-info";

export const AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "aif",
  "aiff",
  "aifc",
  "ogg",
  "oga",
  "aac",
  "m4a",
  "flac",
  "opus",
  "weba",
  "amr",
  "mid",
  "midi",
  "caf",
  "au",
  "snd",
  "wma",
];
export const VIDEO_EXTENSIONS = [
  "mp4",
  "mpg",
  "mpeg",
  "mpe",
  "mpv",
  "webm",
  "ogv",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "flv",
  "wmv",
  "3gp",
  "3g2",
  "m2ts",
  "m3u8",
];
export const LRC_EXTENSIONS = ["lrc"];

const MB = 1024 * 1024;

/**
 * 扩展名 → 播放用 MIME。
 *
 * **blob 必须带 MIME**：WKWebView 对无类型的 blob 一律按 `SRC_NOT_SUPPORTED` 拒播
 * （实机探针验证：同一个 mp4，无 MIME 报 code=4，带 `video/mp4` 正常解码）——
 * 与图片插件当年"SVG 空白"是同一个根因。表按"WebView 真能解的容器"建：
 * 解不了的编码（wmv/flv/rm…）给不对的 MIME 也没意义，走 octet-stream 让
 * error 事件照常触发 → 退化到系统预览图那条链。
 */
const MEDIA_MIME: Record<string, string> = {
  // 音频
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  aifc: "audio/aiff",
  m4a: "audio/mp4",
  aac: "audio/aac", // 裸 AAC 流很多引擎不认，解不了会走 error 链，属如实降级
  caf: "audio/x-caf",
  au: "audio/basic",
  snd: "audio/basic",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg", // WebKit 里 opus 常封在 ogg/-webm；裸流解不了走 error 链
  weba: "audio/webm",
  mid: "audio/midi",
  midi: "audio/midi",
  amr: "audio/amr",
  // 视频
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  mpe: "video/mpeg",
  mpv: "video/mp4", // 无音频的 MPEG 流，容器按 mp4 给
  m2ts: "video/mp2t",
};

function mediaMimeFor(ext: string): string {
  return MEDIA_MIME[ext] ?? "application/octet-stream";
}

/** 人类可读体积（与状态栏口径一致）。 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface MediaParts {
  wrap: HTMLElement;
  meta: HTMLElement;
  /** 系统预览图的 object URL（销毁时要释放）。 */
  posterUrl?: string;
  /** 元信息行前缀（文件名 · 体积），事件回调里复用它拼时长/分辨率。 */
  base: string;
}

/** 建立播放器骨架（音频/视频共用）。 */
function createMediaShell(kind: "audio" | "video", ctx: PreviewContext, size: number): MediaParts {
  const wrap = document.createElement("div");
  wrap.className = `kb-media kb-media-${kind}`;
  const stage = document.createElement("div");
  stage.className = "kb-media-stage";
  const meta = document.createElement("p");
  meta.className = "kb-media-meta";
  const base = `${ctx.name} · ${humanSize(size)}`;
  meta.textContent = base;
  wrap.append(stage, meta);
  return { wrap, meta, base };
}

/**
 * 解不了编码时请**系统**出一张预览图（Quick Look）贴在海报位。
 * 我们解不了，但 Quick Look 常常能出第一帧 —— 比只给一句"请用默认应用打开"有用得多。
 */
async function attachSystemPoster(
  ctx: PreviewContext,
  parts: MediaParts,
  fallbackNote: string,
): Promise<void> {
  const stage = parts.wrap.querySelector(".kb-media-stage");
  // 拿不到系统预览图 → 给完整可操作的那句话（"请用默认应用打开"）
  if (!stage || !ctx.systemThumbnail) {
    parts.meta.textContent = fallbackNote;
    return;
  }
  const bytes = await ctx.systemThumbnail();
  if (!bytes) {
    parts.meta.textContent = fallbackNote;
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const img = document.createElement("img");
  img.className = "kb-media-poster";
  img.alt = ctx.name;
  img.src = url;
  stage.replaceChildren(img);
  // 有图时文案简短（头部那个「默认应用打开」按钮就在旁边，不必重复）
  parts.meta.textContent = `${parts.base} —— WebView 解不了这个编码 · 上图为系统生成的预览帧`;
  parts.posterUrl = url;
}

/** 播放器事件 → 元信息行（时长、分辨率）；解不了码时如实说明。 */
function describeMedia(el: HTMLMediaElement, kind: "audio" | "video", parts: MediaParts, ctx: PreviewContext): void {
  el.addEventListener("loadedmetadata", () => {
    const bits = [formatTime(el.duration)];
    if (kind === "video") {
      const video = el as HTMLVideoElement;
      if (video.videoWidth) bits.push(`${video.videoWidth}×${video.videoHeight}`);
    }
    parts.meta.textContent = `${parts.base} · ${bits.join(" · ")}`;
  });
  el.addEventListener("error", () => {
    void attachSystemPoster(ctx, parts, `${parts.base} —— 这个编码 WebView 解不了，请用默认应用打开`);
    parts.meta.textContent = `${parts.base} —— 这个编码 WebView 解不了，请用默认应用打开`;
  });
}

/** HLS：自定义 loader，把 `kb://<rel>` 映射回知识库文件（离线，不碰网络）。 */
async function attachHls(
  video: HTMLVideoElement,
  ctx: PreviewContext,
  onFatal: (message: string) => void,
): Promise<() => void> {
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) {
    onFatal("当前 WebView 不支持 HLS 播放，请用默认应用打开");
    return () => {};
  }
  const dir = ctx.rel.includes("/") ? ctx.rel.slice(0, ctx.rel.lastIndexOf("/") + 1) : "";
  const readSibling = ctx.readSibling;
  if (!readSibling) {
    onFatal("当前宿主不支持分片读取，无法播放 HLS");
    return () => {};
  }

  class KbLoader {
    private aborted = false;
    constructor(private readonly read: (rel: string) => Promise<Uint8Array>) {}
    load(context: { url: string }, _config: unknown, callbacks: Record<string, unknown>): void {
      const url = String(context.url);
      const rel = url.startsWith("kb://") ? url.slice(5) : "";
      if (!rel) {
        (callbacks.onError as (e: unknown, r: unknown) => void)?.({}, { reason: "url", response: { code: 0, text: "非知识库地址" } });
        return;
      }
      void this.read(decodeURIComponent(rel))
        .then((bytes: Uint8Array) => {
          if (this.aborted) return;
          // 分片必须是底层字节：TS/fMP4 交给 hls.js 自己的 transmuxer
          const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          (callbacks.onSuccess as (r: unknown, s: unknown) => void)(
            { url: context.url, data },
            { url: context.url, data },
          );
        })
        .catch((e: unknown) => {
          (callbacks.onError as (e: unknown, r: unknown) => void)?.({}, { reason: "load", response: { code: 0, text: String(e) } });
        });
    }
    abort(): void {
      this.aborted = true;
    }
    destroy(): void {
      this.aborted = true;
    }
    getCacheKey(context: { url: string }): string {
      return context.url;
    }
  }

  const Loader = KbLoader.bind(null, readSibling) as never; // 绑定读取通道后再交给 hls.js
  const hls = new Hls({
    enableWorker: false, // 分片由我们读，worker 里没有 Tauri 通道
    loader: Loader,
    pLoader: Loader,
    fLoader: Loader,
  });
  // 播放列表在知识库内，相对分片地址由 hls.js 相对本地址解析 → 仍落在 kb:// 下
  const baseUrl = `kb://${dir}`;
  hls.attachMedia(video);
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) onFatal(`HLS 播放失败（${data.details ?? data.type}）`);
  });
  const playlistUrl = `${baseUrl}${ctx.rel.slice(dir.length)}`;
  hls.loadSource(playlistUrl);
  return () => hls.destroy();
}

async function renderAudio(ctx: PreviewContext): Promise<PreviewInstance> {
  const bytes = await ctx.readBytes();
  const parts = createMediaShell("audio", ctx, bytes.byteLength);
  const el = document.createElement("audio");
  el.controls = true;
  el.preload = "metadata";
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaMimeFor(ctx.ext) }));
  el.src = url;
  parts.wrap.querySelector(".kb-media-stage")!.appendChild(el);
  describeMedia(el, "audio", parts, ctx);
  // 容器头解析（照 OFV）：与播放无关，解不了的文件也能说清"它是什么"（进状态栏）
  ctx.onInfo?.(mediaInfoLine(parseAudioInfo(bytes, ctx.ext.toUpperCase())));
  ctx.container.replaceChildren(parts.wrap);
  return {
    destroy: () => {
      URL.revokeObjectURL(url);
      if (parts.posterUrl) URL.revokeObjectURL(parts.posterUrl);
    },
  };
}

async function renderVideo(ctx: PreviewContext): Promise<PreviewInstance> {
  const bytes = await ctx.readBytes();
  const parts = createMediaShell("video", ctx, bytes.byteLength);
  const el = document.createElement("video");
  el.controls = true;
  el.preload = "metadata";
  el.playsInline = true;
  parts.wrap.querySelector(".kb-media-stage")!.appendChild(el);

  let cleanup: () => void = () => {};
  let url: string | null = null;
  if (ctx.ext === "m3u8") {
    // 播放列表本身是文本，播放交给 hls.js
    cleanup = await attachHls(el, ctx, (message) => {
      parts.meta.textContent = message;
    });
  } else {
    url = URL.createObjectURL(new Blob([bytes], { type: mediaMimeFor(ctx.ext) }));
    el.src = url;
    el.load();
  }
  describeMedia(el, "video", parts, ctx);
  ctx.onInfo?.(mediaInfoLine(parseVideoInfo(bytes, ctx.ext.toUpperCase())));
  ctx.container.replaceChildren(parts.wrap);
  return {
    destroy() {
      cleanup();
      if (url) URL.revokeObjectURL(url);
      if (parts.posterUrl) URL.revokeObjectURL(parts.posterUrl);
    },
  };
}

interface LrcLine {
  time: string;
  text: string;
}

/** 解析 LRC：`[mm:ss.xx]` 时间标签 + `[ti:]/[ar:]` 元信息；一行多标签取第一个。 */
export function parseLrc(text: string): { meta: { key: string; value: string }[]; lines: LrcLine[] } {
  const meta: { key: string; value: string }[] = [];
  const lines: LrcLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tags = line.match(/\[[^\]]+\]/g) ?? [];
    const body = line.replace(/\[[^\]]+\]/g, "").trim();
    for (const tag of tags) {
      const inner = tag.slice(1, -1);
      const colon = inner.indexOf(":");
      if (colon < 0) continue;
      const key = inner.slice(0, colon).trim().toLowerCase();
      const value = inner.slice(colon + 1).trim();
      if (/^\d+$/.test(key) || /^\d+:\d+/.test(inner)) {
        if (!body) continue;
        // 时间标签：保持 mm:ss.xx 原样显示
        if (!lines.some((l) => l.time === inner && l.text === body)) lines.push({ time: inner, text: body });
      } else if (key) {
        meta.push({ key, value });
      }
    }
  }
  return { meta, lines };
}

function renderLrc(ctx: PreviewContext, text: string): PreviewInstance {
  const { meta, lines } = parseLrc(text);
  const wrap = document.createElement("div");
  wrap.className = "kb-lrc";
  if (meta.length) {
    const info = document.createElement("dl");
    info.className = "kb-lrc-meta";
    for (const item of meta) {
      const dt = document.createElement("dt");
      dt.textContent = item.key;
      const dd = document.createElement("dd");
      dd.textContent = item.value;
      info.append(dt, dd);
    }
    wrap.appendChild(info);
  }
  const list = document.createElement("ol");
  list.className = "kb-lrc-lines";
  for (const line of lines) {
    const li = document.createElement("li");
    li.className = "kb-lrc-line";
    const time = document.createElement("span");
    time.className = "kb-lrc-time";
    time.textContent = line.time;
    const body = document.createElement("span");
    body.className = "kb-lrc-text";
    body.textContent = line.text;
    li.append(time, body);
    list.appendChild(li);
  }
  if (!lines.length) {
    const empty = document.createElement("p");
    empty.className = "kb-note";
    empty.textContent = "这份歌词里没有时间标签，按纯文本显示。";
    wrap.appendChild(empty);
  } else {
    wrap.appendChild(list);
  }
  ctx.container.replaceChildren(wrap);
  return {};
}

export const audioPlugin = { id: "audio", extensions: AUDIO_EXTENSIONS, render: renderAudio };
export const videoPlugin = { id: "video", extensions: VIDEO_EXTENSIONS, render: renderVideo };
export const lrcPlugin = {
  id: "lrc",
  extensions: LRC_EXTENSIONS,
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    return renderLrc(ctx, await ctx.readText());
  },
};

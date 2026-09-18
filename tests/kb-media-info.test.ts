/**
 * 媒体容器头解析器的**逐格式断言**（`media-info.ts`）。
 *
 * 为什么不满足于"能解析不抛错"：这些解析器是照 OFV 逐函数移植的，每个容器都有
 * 精确的字节布局 —— 样本按各格式规范手写最小头，断言解析出的**具体字段值**
 * （采样率/声道/时长/尺寸），错一个字节布局就会在这层红掉。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mediaInfoLine, parseAudioInfo, parseVideoInfo } from "../src/knowledge/preview/plugins/media-info";

const DIR = "/tmp/kb-media-info";
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, name)));

describe("音频容器解析（OFV audio.ts 移植）", () => {
  it("WAV：声道/采样率/位深/时长", () => {
    const info = parseAudioInfo(read("a.wav"), "WAV");
    expect(info.format).toBe("WAV");
    expect(info.channels).toBe(1);
    expect(info.sampleRate).toBe(8000);
    expect(info.bitDepth).toBe(16);
    expect(info.duration).toBe("0:01");
  });

  it("FLAC：STREAMINFO 的采样率/声道/位深/总样本", () => {
    const info = parseAudioInfo(read("a.flac"), "FLAC");
    expect(info.format).toBe("FLAC");
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.bitDepth).toBe(16);
    expect(info.duration).toBe("0:03");
  });

  it("MP3：ID3v2 标签 + 首帧的码率/采样率", () => {
    const info = parseAudioInfo(read("a.mp3"), "MP3");
    expect(info.format).toBe("MP3");
    expect(info.tags).toBe("ID3v2.3.0");
    expect(info.codec).toBe("MPEG-1 Layer III");
    expect(info.bitrate).toBe("128 kbps");
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
  });

  it("Ogg Opus：OpusHead 的声道与输入采样率", () => {
    const info = parseAudioInfo(read("a.opus"), "OPUS");
    expect(info.format).toBe("Ogg");
    expect(info.codec).toBe("Opus");
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(48000);
  });

  it("AIFF：COMM chunk + 80-bit 扩展浮点采样率", () => {
    const info = parseAudioInfo(read("a.aiff"), "AIFF");
    expect(info.format).toBe("AIFF");
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(44100);
    expect(info.bitDepth).toBe(16);
  });

  it("AU：编码名与时长", () => {
    const info = parseAudioInfo(read("a.au"), "AU");
    expect(info.format).toBe("AU/SND");
    expect(info.codec).toBe("16-bit linear PCM");
    expect(info.sampleRate).toBe(8000);
    expect(info.channels).toBe(1);
    expect(info.duration).toBe("0:00");
  });

  it("MIDI：SMF 格式与 tick", () => {
    const info = parseAudioInfo(read("a.mid"), "MID");
    expect(info.format).toBe("MIDI");
    expect(info.codec).toBe("SMF 1");
    expect(info.channels).toBe(16);
    expect(info.note).toBe("480 ticks/quarter");
  });

  it("AAC ADTS：profile/采样率表", () => {
    const info = parseAudioInfo(read("a.aac"), "AAC");
    expect(info.format).toBe("AAC");
    expect(info.codec).toBe("AAC ADTS profile 2");
    expect(info.sampleRate).toBe(44100);
  });

  it("认不出的头 → 如实说（不猜）", () => {
    const info = parseAudioInfo(new Uint8Array([1, 2, 3, 4]), "XYZ");
    expect(info.format).toBe("XYZ");
    expect(info.note).toBe("暂未识别音频头结构");
  });
});

describe("视频容器解析（OFV video.ts 移植）", () => {
  it("MP4：ftyp 品牌 + mvhd 时长 + tkhd 尺寸 + 轨道数", () => {
    const info = parseVideoInfo(read("v.mp4"), "MP4");
    expect(info.format).toBe("MP4");
    expect(info.duration).toBe("0:03");
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.tracks).toBe(1);
  });

  it("MOV：qt 品牌识别为 MOV 而不是 MP4", () => {
    expect(parseVideoInfo(read("v.mov"), "MOV").format).toBe("MOV");
  });

  it("AVI：avih 的帧率换算时长与尺寸", () => {
    const info = parseVideoInfo(read("v.avi"), "AVI");
    expect(info.format).toBe("AVI");
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.duration).toBe("0:06");
    expect(info.bitrate).toBe("2400 kbps");
  });

  it("MKV（EBML）：DocType + Duration×TimecodeScale + 编码与尺寸", () => {
    const info = parseVideoInfo(read("v.mkv"), "MKV");
    expect(info.format).toBe("Matroska");
    expect(info.duration).toBe("0:07");
    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(info.codec).toContain("V_MPEG4/ISO/AVC");
  });

  it("HLS 播放列表：片段数/变体数/总时长/码率", () => {
    const info = parseVideoInfo(read("v.m3u8"), "M3U8");
    expect(info.format).toBe("HLS");
    expect(info.segments).toBe(2);
    expect(info.variants).toBe(1);
    expect(info.duration).toBe("0:18");
    expect(info.bitrate).toBe("1280 kbps");
  });

  it("DASH MPD：ISO8601 时长换算 + Representation 计数", () => {
    const info = parseVideoInfo(read("v.mpd"), "MPD");
    expect(info.format).toBe("DASH");
    expect(info.duration).toBe("1:02:03");
    expect(info.variants).toBe(2);
  });
});

describe("mediaInfoLine（状态栏单行口径）", () => {
  it("只拼接有值的字段", () => {
    expect(mediaInfoLine({ format: "MP4", width: 1920, height: 1080, duration: "0:03" })).toBe("MP4 · 1920×1080 · 0:03");
    expect(mediaInfoLine({ format: "WAV" })).toBe("WAV");
  });
});

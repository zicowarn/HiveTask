/**
 * 媒体容器头解析器的**逐格式断言**（`media-info.ts`）。
 *
 * 为什么不满足于"能解析不抛错"：这些解析器是照 OFV 逐函数移植的，每个容器都有
 * 精确的字节布局 —— 样本按各格式规范手写最小头，断言解析出的**具体字段值**
 * （采样率/声道/时长/尺寸），错一个字节布局就会在这层红掉。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mediaInfoLine, parseAudioInfo, parseVideoInfo } from "../src/knowledge/preview/plugins/media-info";

// 夹具入库（tests/fixtures/media-info/，已提交；下方 beforeAll 可在其缺失时自愈重建，
// 生成逻辑与 scripts/make-kb-media-fixtures.py 等价）——曾放 /tmp 被系统清理丢了导致整组红。
const DIR = new URL("./fixtures/media-info/", import.meta.url).pathname;
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, name)));

/**
 * 样本由测试**自产**（此前放 /tmp 靠外部脚本，机器重启清掉 /tmp 后整条红）。
 * 字节布局与各格式规范一一对应，注释见各 write 处。
 */
beforeAll(() => {
  if (existsSync(join(DIR, "v.mpd"))) return; // 已生成
  mkdirSync(DIR, { recursive: true });
  const w = (name: string, data: Uint8Array | string): void =>
    writeFileSync(join(DIR, name), typeof data === "string" ? data : Buffer.from(data));
  const u32 = (v: number, big: boolean): Uint8Array => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v, !big);
    return out;
  };
  const atom = (t: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, 8 + body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
    out.set(body, 8);
    return out;
  };
  const zeros = (n: number): Uint8Array => new Uint8Array(n);

  // WAV：PCM 16bit 单声道 8kHz 1 秒（44 字节头 + data）
  const wav = new Uint8Array(44 + 16000);
  const dv = new DataView(wav.buffer);
  for (let i = 0; i < 4; i++) wav[i] = "RIFF".charCodeAt(i);
  dv.setUint32(4, 36 + 16000, true);
  for (let i = 0; i < 4; i++) wav[8 + i] = "WAVE".charCodeAt(i);
  for (let i = 0; i < 4; i++) wav[12 + i] = "fmt ".charCodeAt(i);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  for (let i = 0; i < 4; i++) wav[36 + i] = "data".charCodeAt(i);
  dv.setUint32(40, 16000, true);
  w("a.wav", wav);

  // FLAC：STREAMINFO
  const sr = 44100, total = 44100 * 3;
  const stream = new Uint8Array(34);
  stream[10] = (sr >> 12) & 0xff; stream[11] = (sr >> 4) & 0xff;
  // STREAMINFO 位域：b10..b17 = 20bit采样率 | 3bit声道-1 | 5bit位深-1 | 36bit总样本
  // 这里 sr=44100(0xAC44，低 4 位=4)、channels=2（编码 1）、bitDepth=16（编码 15）
  stream[12] = ((sr & 0xf) << 4) | (1 << 1) | (15 >> 4);
  const tb = BigInt(total);
  stream[13] = ((15 & 0xf) << 4) | Number((tb >> 32n) & 0xf);
  stream[14] = Number((tb >> 24n) & 0xff);
  stream[15] = Number((tb >> 16n) & 0xff);
  stream[16] = Number((tb >> 8n) & 0xff);
  stream[17] = Number(tb & 0xff);
  w("a.flac", Buffer.concat([Buffer.from("fLaC"), Uint8Array.of(0x80), u32(34, true).subarray(1), stream]));

  // MP3：ID3v2.3 + MPEG-1 Layer III 128kbps
  w("a.mp3", Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0002\u0000\u0000"),
    Uint8Array.of(0xff, 0xfb, 0x90, 0x00), zeros(413)]));

  // Ogg Opus：一页 OpusHead
  const opusHead = Buffer.concat([Buffer.from("OpusHead"), Uint8Array.of(1, 2), (() => { const b = new Uint8Array(8); new DataView(b.buffer).setUint16(0, 312, true); new DataView(b.buffer).setUint32(2, 48000, true); return b; })(), Uint8Array.of(0, 0)]);
  const page = Buffer.concat([Buffer.from("OggS"), Uint8Array.of(0, 2), zeros(8), u32(1, true), u32(0, true), u32(0, true), Uint8Array.of(opusHead.length), opusHead]);
  w("a.opus", page);

  // AIFF COMM（80-bit 扩展浮点 44100 = 0x400EAC44000000000000）
  const comm = Buffer.concat([(() => { const b = new Uint8Array(8); const d = new DataView(b.buffer); d.setInt16(0, 2); d.setUint32(2, 44100 * 3); d.setUint16(6, 16); return b; })(), Uint8Array.of(0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0)]);
  const aiff = Buffer.concat([Buffer.from("FORM"), u32(4 + 8 + comm.length, true), Buffer.from("AIFF"), Buffer.from("COMM"), u32(comm.length, true), comm]);
  w("a.aiff", aiff);

  w("a.au", Buffer.concat([Buffer.from(".snd"), u32(24, true), u32(2000, true), u32(3, true), u32(8000, true), u32(1, true), u32(0, true), zeros(2000)]));
  w("a.mid", Buffer.concat([Buffer.from("MThd"), u32(6, true), u32(1, true), u32(16, true), u32(480, true)]));
  w("a.aac", Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, ...zeros(100)));

  // MP4：ftyp + moov(mvhd v0 3s + trak(tkhd v0 1920×1080))
  const mvhd = atom("mvhd", new Uint8Array([0, 0, 0, 0, ...u32(0, true), ...u32(0, true), ...u32(600, true), ...u32(1800, true), ...zeros(80 - 20)]));
  const tkhd = atom("tkhd", new Uint8Array([
    0, 0, 0, 0, ...u32(0, true), ...u32(0, true), ...u32(1, true), ...u32(0, true), ...u32(1800, true),
    ...zeros(8), 0, 0, 0, 0x01, 0, 0, 0, 0,
    ...u32(0x10000, true), ...zeros(4), 0, 0, 0, 0, ...u32(0x10000, true), ...zeros(4), 0, 0, 0, ...u32(0x40000000, true),
    ...u32(1920 << 16, true), ...u32(1080 << 16, true),
  ]));
  const moov = atom("moov", new Uint8Array([...mvhd, ...atom("trak", tkhd)]));
  const ftyp = atom("ftyp", new Uint8Array([...Buffer.from("isom"), ...u32(512, true), ...Buffer.from("isomiso2")]));
  w("v.mp4", Buffer.concat([ftyp, moov]));
  w("v.mov", atom("ftyp", new Uint8Array([...Buffer.from("qt  "), ...u32(512, true), ...Buffer.from("qt  ")])) && Buffer.concat([atom("ftyp", new Uint8Array([...Buffer.from("qt  "), ...u32(512, true), ...Buffer.from("qt  ")])), moov]));

  // AVI（小端）
  const avih = Buffer.concat([Buffer.from("avih"), u32(56, true),
    u32(41667, true), u32(300000, true), u32(0, true), u32(0, true),
    u32(150, true), u32(0, true), u32(2, true), u32(0, true),
    u32(1920, true), u32(1080, true), zeros(16)]);
  w("v.avi", Buffer.concat([Buffer.from("RIFF"), u32(4 + 8 + avih.length, true), Buffer.from("AVI "), avih]));

  // MKV：EBML + Segment(Info + Tracks(TrackEntry(CodecID + TrackType + Video)))
  const ebml = (id: number, body: Uint8Array): Uint8Array => {
    const n = Math.max(1, Math.ceil(body.length.toString(2).length / 8));
    const sizeVint = new Uint8Array(n);
    sizeVint[0] = (0x80 >> (n - 1)) | (body.length >> ((n - 1) * 8));
    for (let i = 1; i < n; i++) sizeVint[i] = (body.length >> ((n - 1 - i) * 8)) & 0xff;
    const idBytes: number[] = [];
    let v = id;
    while (v > 0) { idBytes.unshift(v & 0xff); v >>= 8; }
    return new Uint8Array([...idBytes, ...sizeVint, ...body]);
  };
  const u32e = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; };
  const hdr = ebml(0x1a45dfa3, ebml(0x4282, Buffer.from("matroska")));
  const info = ebml(0x1549a966, ebml(0x2ad7b1, u32e(1000000)) + ebml(0x4489, (() => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, 6500.0); return b; })()));
  const video = ebml(0xe0, new Uint8Array([...u32e(1280), ...u32e(720)]));
  const track = ebml(0xae, new Uint8Array([...ebml(0x86, Buffer.from("V_MPEG4/ISO/AVC")), ...ebml(0x83, Uint8Array.of(1)), ...video]));
  const tracks = ebml(0x1654ae6b, track);
  w("v.mkv", Buffer.concat([hdr, ebml(0x18538067, new Uint8Array([...info, ...tracks]))]));

  w("v.m3u8", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nindex.m3u8\n#EXTINF:9.009,\nseg0.ts\n#EXTINF:9.009,\nseg1.ts\n");
  w("v.mpd", '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash" mediaPresentationDuration="PT1H2M3S"><AdaptationSet><Representation id="1"/><Representation id="2"/></AdaptationSet></MPD>');
});

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

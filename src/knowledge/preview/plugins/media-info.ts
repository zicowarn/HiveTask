/**
 * 媒体容器头解析 —— **逐函数对照移植**自 open-file-viewer（MIT）：
 * `packages/core/src/plugins/audio.ts` 的 8 个音频解析器与
 * `packages/core/src/plugins/video.ts` 的 5 个视频解析器 + 全部读字节辅助函数。
 *
 * OFV 把解析结果画在自己的信息条上；我们按插件契约改走 `ctx.onInfo` → 状态栏
 * （各插件不画信息条，避免与面板头部凑成两行 —— 用户实测定下的规矩）。
 *
 * 解析是**纯字节 → 纯数据**，与播放（`<audio>`/`<video>` 能不能解这个编码）完全独立：
 * 播放器解不了的文件（如 mkv）照样能读出容器信息 —— 这正是"解不了也要说清它是什么"。
 *
 * 修改点（相对 OFV 原文）：类型签名收紧、Ogg 页收集对超大文件的截断保护、
 * `formatDuration` 支持小时段（OFV 音频版是 m:ss，视频版支持 h:mm:ss，取并集）。
 */

/** 容器元信息（字段可选，渲染时缺哪项不显示哪项）。 */
export interface MediaInfo {
  format: string;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  width?: number;
  height?: number;
  bitrate?: string;
  duration?: string;
  tracks?: number;
  variants?: number;
  segments?: number;
  tags?: string;
  note?: string;
}

// ---- 读字节辅助（OFV audio.ts/video.ts 尾部同款） ----

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[offset + index]);
  return out;
}

function findAscii(bytes: Uint8Array, value: string, start = 0): number {
  for (let offset = start; offset + value.length <= bytes.length; offset += 1) {
    let matched = true;
    for (let index = 0; index < value.length; index += 1) {
      if (bytes[offset + index] !== value.charCodeAt(index)) {
        matched = false;
        break;
      }
    }
    if (matched) return offset;
  }
  return -1;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint16(offset, true);
}
function readUint16Be(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint16(offset, false);
}
function readUint32Le(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint32(offset, true);
}
function readUint32Be(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint32(offset, false);
}
function readUint64Le(bytes: Uint8Array, offset: number): bigint {
  return (BigInt(readUint32Le(bytes, offset + 4)) << 32n) | BigInt(readUint32Le(bytes, offset));
}
function readUint64Be(bytes: Uint8Array, offset: number): bigint {
  return (BigInt(readUint32Be(bytes, offset)) << 32n) | BigInt(readUint32Be(bytes, offset + 4));
}
function readSynchsafe(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

/** 秒 → `m:ss` / `h:mm:ss`（OFV 音频/视频两个版本的并集）。 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

// ---- 音频解析器（OFV audio.ts，逐个对照） ----

function parseWaveInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 44 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WAVE") return null;
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const chunk = asciiAt(bytes, offset, 4);
    const size = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (chunk === "fmt " && dataOffset + 16 <= bytes.length) {
      channels = readUint16Le(bytes, dataOffset + 2);
      sampleRate = readUint32Le(bytes, dataOffset + 4);
      byteRate = readUint32Le(bytes, dataOffset + 8);
      bitDepth = readUint16Le(bytes, dataOffset + 14);
    }
    if (chunk === "data") dataBytes = size;
    // 奇数长度 chunk 按 RIFF 规则补齐一位
    offset += 8 + size + (size % 2);
  }
  return {
    format: "WAV",
    codec: "PCM",
    sampleRate,
    channels,
    bitDepth,
    bitrate: byteRate ? `${Math.round((byteRate * 8) / 1000)} kbps` : undefined,
    duration: byteRate && dataBytes ? formatDuration(dataBytes / byteRate) : undefined,
  };
}

function parseFlacInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 42 || asciiAt(bytes, 0, 4) !== "fLaC") return null;
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const type = bytes[offset] & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const dataOffset = offset + 4;
    if (type === 0 && dataOffset + 34 <= bytes.length) {
      const b = bytes.slice(dataOffset, dataOffset + 18);
      const sampleRate = (b[10] << 12) | (b[11] << 4) | ((b[12] & 0xf0) >> 4);
      const channels = ((b[12] & 0x0e) >> 1) + 1;
      const bitDepth = (((b[12] & 0x01) << 4) | ((b[13] & 0xf0) >> 4)) + 1;
      const totalSamples = (BigInt(b[13] & 0x0f) << 32n) | (BigInt(b[14]) << 24n) | (BigInt(b[15]) << 16n) | (BigInt(b[16]) << 8n) | BigInt(b[17]);
      return {
        format: "FLAC",
        codec: "FLAC",
        sampleRate,
        channels,
        bitDepth,
        duration: sampleRate && totalSamples > 0n ? formatDuration(Number(totalSamples) / sampleRate) : undefined,
      };
    }
    offset += 4 + length;
  }
  return { format: "FLAC", codec: "FLAC", note: "未找到 STREAMINFO metadata block" };
}

function parseId3Mp3Info(bytes: Uint8Array): MediaInfo | null {
  let offset = 0;
  let tags: string | undefined;
  if (bytes.length >= 10 && asciiAt(bytes, 0, 3) === "ID3") {
    tags = `ID3v2.${bytes[3]}.${bytes[4]}`;
    offset = 10 + readSynchsafe(bytes, 6);
  }
  const scanEnd = Math.min(bytes.length, offset + 4096);
  for (let index = offset; index + 3 < scanEnd; index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) {
      const versionBits = (bytes[index + 1] >> 3) & 0x03;
      const layerBits = (bytes[index + 1] >> 1) & 0x03;
      const bitrateIndex = (bytes[index + 2] >> 4) & 0x0f;
      const sampleIndex = (bytes[index + 2] >> 2) & 0x03;
      const channelMode = (bytes[index + 3] >> 6) & 0x03;
      const mpegVersion = versionBits === 3 ? "MPEG-1" : versionBits === 2 ? "MPEG-2" : versionBits === 0 ? "MPEG-2.5" : "MPEG";
      const layer = layerBits === 3 ? "I" : layerBits === 2 ? "II" : layerBits === 1 ? "III" : "?";
      const rates = versionBits === 3 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
      const mpeg1Layer3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
      const mpeg2Layer3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const bitrate =
        bitrateIndex <= 0 || bitrateIndex >= 15 || layerBits !== 1
          ? undefined
          : `${(versionBits === 3 ? mpeg1Layer3 : mpeg2Layer3)[bitrateIndex]} kbps`;
      return { format: "MP3", codec: `${mpegVersion} Layer ${layer}`, sampleRate: rates[sampleIndex], channels: channelMode === 3 ? 1 : 2, bitrate, tags };
    }
  }
  return tags ? { format: "MP3", tags, note: "未在头部扫描到 MPEG frame" } : null;
}

type OggPage = { granule: bigint; packets: Uint8Array[] };

/** Ogg 页收集（OFV 同款）；页数截断保护是我们加的（OFV 会把整个文件读完）。 */
function collectOggPages(bytes: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  let offset = 0;
  let continuedPacket: number[] = [];
  while (offset + 27 <= bytes.length && asciiAt(bytes, offset, 4) === "OggS") {
    const segmentCount = bytes[offset + 26];
    const segmentTableOffset = offset + 27;
    const dataOffset = segmentTableOffset + segmentCount;
    if (dataOffset > bytes.length) break;
    const sizes = Array.from(bytes.slice(segmentTableOffset, dataOffset));
    const payloadLength = sizes.reduce((sum, value) => sum + value, 0);
    const payloadEnd = dataOffset + payloadLength;
    if (payloadEnd > bytes.length) break;
    const pagePackets: Uint8Array[] = [];
    let packetOffset = dataOffset;
    for (const size of sizes) {
      continuedPacket.push(...bytes.slice(packetOffset, packetOffset + size));
      packetOffset += size;
      if (size < 255) {
        pagePackets.push(new Uint8Array(continuedPacket));
        continuedPacket = [];
      }
    }
    pages.push({ granule: readUint64Le(bytes, offset + 6), packets: pagePackets });
    offset = payloadEnd;
    // 大文件只收前 64 页：元信息（编码头在第一页）早就够了，读完整文件只为时长，
    // 而granule 时长在尾部 —— 权衡后宁可"多数文件给全信息、超大文件缺时长"
    if (pages.length >= 64) break;
  }
  return pages;
}

function parseOggInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 36 || asciiAt(bytes, 0, 4) !== "OggS") return null;
  const pages = collectOggPages(bytes);
  const firstPacket = pages[0]?.packets[0];
  const lastGranule = [...pages].reverse().find((page) => page.granule > 0n)?.granule;
  if (firstPacket && asciiAt(firstPacket, 0, 8) === "OpusHead") {
    const preSkip = firstPacket.length >= 12 ? readUint16Le(firstPacket, 10) : 0;
    const sampleRate = firstPacket.length >= 16 ? readUint32Le(firstPacket, 12) : 48000;
    const totalSamples = lastGranule === undefined ? undefined : lastGranule - BigInt(preSkip);
    return {
      format: "Ogg",
      codec: "Opus",
      channels: firstPacket[9],
      sampleRate,
      duration: totalSamples !== undefined && totalSamples > 0n ? formatDuration(Number(totalSamples) / 48000) : undefined,
      note: `${pages.length} 页`,
    };
  }
  if (firstPacket && firstPacket[0] === 0x01 && asciiAt(firstPacket, 1, 6) === "vorbis") {
    const sampleRate = firstPacket.length >= 16 ? readUint32Le(firstPacket, 12) : undefined;
    let bitrate: string | undefined;
    if (firstPacket.length >= 28) {
      const nominal = readUint32Le(firstPacket, 20);
      if (nominal > 0) bitrate = `${Math.round(nominal / 1000)} kbps`;
      else {
        const upper = readUint32Le(firstPacket, 16);
        const lower = readUint32Le(firstPacket, 24);
        if (upper > 0 && lower > 0) bitrate = `${Math.round((upper + lower) / 2 / 1000)} kbps`;
      }
    }
    return {
      format: "Ogg",
      codec: "Vorbis",
      channels: firstPacket[11],
      sampleRate,
      bitrate,
      duration: sampleRate && lastGranule !== undefined && lastGranule > 0n ? formatDuration(Number(lastGranule) / sampleRate) : undefined,
      note: `${pages.length} 页`,
    };
  }
  return { format: "Ogg", note: pages.length > 0 ? `未识别 Ogg codec header，${pages.length} 页` : "未识别 Ogg codec header" };
}

function parseAiffInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 12 || asciiAt(bytes, 0, 4) !== "FORM" || !["AIFF", "AIFC"].includes(asciiAt(bytes, 8, 4))) return null;
  const format = asciiAt(bytes, 8, 4);
  let offset = 12;
  while (offset + 26 <= bytes.length) {
    const chunk = asciiAt(bytes, offset, 4);
    const size = readUint32Be(bytes, offset + 4);
    if (chunk === "COMM") {
      // AIFF 采样率是 80-bit 扩展浮点（1 符号位 + 15 指数 + 64 尾数）
      const exponent = readUint16Be(bytes, offset + 16) & 0x7fff;
      let mantissa = 0;
      for (let index = 0; index < 8; index += 1) mantissa = mantissa * 256 + bytes[offset + 18 + index];
      return {
        format,
        channels: readUint16Be(bytes, offset + 8),
        bitDepth: readUint16Be(bytes, offset + 14),
        sampleRate: Math.round(mantissa * Math.pow(2, exponent - 16383 - 63)),
      };
    }
    offset += 8 + size + (size % 2);
  }
  return { format, note: "未找到 COMM chunk" };
}

const AU_ENCODINGS: Record<number, string> = {
  1: "8-bit μ-law",
  2: "8-bit linear PCM",
  3: "16-bit linear PCM",
  4: "24-bit linear PCM",
  5: "32-bit linear PCM",
  6: "32-bit float",
  7: "64-bit float",
  23: "G.721 ADPCM",
  24: "G.722 ADPCM",
  25: "G.723 3-bit ADPCM",
  26: "G.723 5-bit ADPCM",
  27: "8-bit A-law",
};

function parseAuInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 24 || asciiAt(bytes, 0, 4) !== ".snd") return null;
  const dataOffset = readUint32Be(bytes, 4);
  const dataSize = readUint32Be(bytes, 8);
  const encoding = readUint32Be(bytes, 12);
  const sampleRate = readUint32Be(bytes, 16);
  const channels = readUint32Be(bytes, 20);
  const bitDepth = { 1: 8, 2: 8, 3: 16, 4: 24, 5: 32, 6: 32, 7: 64, 27: 8 }[encoding];
  const bytesPerSample = bitDepth ? bitDepth / 8 : 0;
  const resolvedDataSize = dataSize === 0xffffffff ? Math.max(0, bytes.length - dataOffset) : dataSize;
  return {
    format: "AU/SND",
    codec: AU_ENCODINGS[encoding] ?? `encoding ${encoding}`,
    sampleRate,
    channels,
    bitDepth,
    duration:
      sampleRate && channels && bytesPerSample && resolvedDataSize ? formatDuration(resolvedDataSize / (sampleRate * channels * bytesPerSample)) : undefined,
    note: `data @ ${dataOffset} B`,
  };
}

function parseMidiInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 14 || asciiAt(bytes, 0, 4) !== "MThd") return null;
  return { format: "MIDI", codec: `SMF ${readUint16Be(bytes, 8)}`, channels: readUint16Be(bytes, 10), note: `${readUint16Be(bytes, 12)} ticks/quarter` };
}

function parseAdtsAacInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1] & 0xf0) !== 0xf0) return null;
  const profile = ((bytes[2] >> 6) & 0x03) + 1;
  const sampleIndex = (bytes[2] >> 2) & 0x0f;
  const channels = ((bytes[2] & 0x01) << 2) | ((bytes[3] >> 6) & 0x03);
  return {
    format: "AAC",
    codec: `AAC ADTS profile ${profile}`,
    sampleRate: [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][sampleIndex],
    channels: channels || undefined,
    note: "ADTS stream",
  };
}

/** 音频入口：按 OFV 的顺序逐个试（WAV → FLAC → OGG → AIFF → AU → MIDI → AAC → MP3）。 */
export function parseAudioInfo(bytes: Uint8Array, fallbackFormat: string): MediaInfo {
  if (bytes.length === 0) return { format: fallbackFormat, note: "无法读取本地头信息" };
  return (
    parseWaveInfo(bytes) ||
    parseFlacInfo(bytes) ||
    parseOggInfo(bytes) ||
    parseAiffInfo(bytes) ||
    parseAuInfo(bytes) ||
    parseMidiInfo(bytes) ||
    parseAdtsAacInfo(bytes) ||
    parseId3Mp3Info(bytes) || {
      format: fallbackFormat,
      note: "暂未识别音频头结构",
    }
  );
}

// ---- 视频解析器（OFV video.ts，逐个对照） ----

type Mp4Atom = { type: string; start: number; end: number; headerSize: number };

function collectMp4Atoms(bytes: Uint8Array, start: number, end: number): Mp4Atom[] {
  const atoms: Mp4Atom[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32Be(bytes, offset);
    const type = asciiAt(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(readUint64Be(bytes, offset + 8));
      headerSize = 16;
    }
    if (size < headerSize || offset + size > end || !/^[\w ]{4}$/.test(type)) break;
    atoms.push({ type, start: offset, end: offset + size, headerSize });
    offset += size;
  }
  return atoms;
}

function parseMp4Info(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 12 || asciiAt(bytes, 4, 4) !== "ftyp") return null;
  const majorBrand = asciiAt(bytes, 8, 4);
  const info: MediaInfo = { format: majorBrand === "qt  " ? "MOV" : "MP4", codec: majorBrand.trim() || undefined };
  const atoms = collectMp4Atoms(bytes, 0, bytes.length);
  const moov = atoms.find((atom) => atom.type === "moov");
  if (!moov) return info;
  const children = collectMp4Atoms(bytes, moov.start + moov.headerSize, moov.end);
  const mvhd = children.find((atom) => atom.type === "mvhd");
  if (mvhd) {
    const body = mvhd.start + mvhd.headerSize;
    if (bytes[body] === 1 && body + 32 <= bytes.length) {
      const timescale = readUint32Be(bytes, body + 20);
      const duration = readUint64Be(bytes, body + 24);
      if (timescale) info.duration = formatDuration(Number(duration) / timescale);
    } else if (body + 20 <= bytes.length) {
      const timescale = readUint32Be(bytes, body + 12);
      const duration = readUint32Be(bytes, body + 16);
      if (timescale) info.duration = formatDuration(duration / timescale);
    }
  }
  const tracks = children.filter((atom) => atom.type === "trak");
  info.tracks = tracks.length;
  for (const track of tracks) {
    const tkhd = collectMp4Atoms(bytes, track.start + track.headerSize, track.end).find((atom) => atom.type === "tkhd");
    if (!tkhd) continue;
    const sizeOffset = tkhd.start + tkhd.headerSize + (bytes[tkhd.start + tkhd.headerSize] === 1 ? 84 : 72);
    if (sizeOffset + 8 > bytes.length) continue;
    const width = readUint32Be(bytes, sizeOffset) / 65536;
    const height = readUint32Be(bytes, sizeOffset + 4) / 65536;
    if (width && height) {
      info.width = Math.round(width);
      info.height = Math.round(height);
      break;
    }
  }
  return info;
}

function parseAviInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 64 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "AVI ") return null;
  const avihOffset = findAscii(bytes, "avih", 12);
  if (avihOffset < 0 || avihOffset + 56 > bytes.length) return { format: "AVI", note: "未找到 avih header" };
  const microSecPerFrame = readUint32Le(bytes, avihOffset + 8);
  const maxBytesPerSec = readUint32Le(bytes, avihOffset + 16);
  const totalFrames = readUint32Le(bytes, avihOffset + 24);
  const streams = readUint32Le(bytes, avihOffset + 32);
  return {
    format: "AVI",
    width: readUint32Le(bytes, avihOffset + 40),
    height: readUint32Le(bytes, avihOffset + 44),
    tracks: streams,
    bitrate: maxBytesPerSec ? `${Math.round((maxBytesPerSec * 8) / 1000)} kbps` : undefined,
    duration: microSecPerFrame && totalFrames ? formatDuration((microSecPerFrame * totalFrames) / 1_000_000) : undefined,
  };
}

// ---- EBML（Matroska / WebM） ----

type EbmlElement = { id: number; start: number; dataStart: number; dataEnd: number; end: number };

function collectEbmlElements(bytes: Uint8Array, start: number, end: number, limit = 256): EbmlElement[] {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end && elements.length < limit) {
    const firstByte = bytes[offset];
    if (!firstByte) break;
    let idLength = 0;
    for (let length = 1; length <= 4; length += 1) {
      if (firstByte & (0x80 >> (length - 1))) {
        idLength = length;
        break;
      }
    }
    if (!idLength || offset + idLength > end) break;
    let id = 0;
    for (let index = 0; index < idLength; index += 1) id = id * 256 + bytes[offset + index];
    const sizeOffset = offset + idLength;
    const sizeFirst = bytes[sizeOffset];
    if (!sizeFirst) break;
    let sizeLength = 0;
    for (let length = 1; length <= 8; length += 1) {
      if (sizeFirst & (0x80 >> (length - 1))) {
        sizeLength = length;
        break;
      }
    }
    if (!sizeLength || sizeOffset + sizeLength > end) break;
    let size = sizeFirst & (0xff >> sizeLength);
    let max = 0xff >> sizeLength;
    for (let index = 1; index < sizeLength; index += 1) {
      size = size * 256 + bytes[sizeOffset + index];
      max = max * 256 + 0xff;
    }
    const dataStart = sizeOffset + sizeLength;
    const unknown = size === max;
    const dataEnd = unknown ? end : dataStart + size;
    if (dataEnd < dataStart || dataEnd > end) break;
    elements.push({ id, start: offset, dataStart, dataEnd, end: dataEnd });
    offset = dataEnd;
  }
  return elements;
}

function readEbmlString(bytes: Uint8Array, element?: EbmlElement): string | undefined {
  if (!element || element.dataEnd <= element.dataStart || element.dataEnd - element.dataStart > 4096) return undefined;
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(element.dataStart, element.dataEnd))
    .replace(/\0+$/g, "")
    .trim();
}

function readEbmlUInt(bytes: Uint8Array, element?: EbmlElement): number | undefined {
  if (!element || element.dataEnd <= element.dataStart || element.dataEnd - element.dataStart > 6) return undefined;
  let value = 0;
  for (let offset = element.dataStart; offset < element.dataEnd; offset += 1) value = value * 256 + bytes[offset];
  return value;
}

function readEbmlFloat(bytes: Uint8Array, element?: EbmlElement): number | undefined {
  if (!element) return undefined;
  const data = view(bytes);
  if (element.dataEnd - element.dataStart === 4) return data.getFloat32(element.dataStart, false);
  if (element.dataEnd - element.dataStart === 8) return data.getFloat64(element.dataStart, false);
  return undefined;
}

function parseEbmlSegmentInfo(bytes: Uint8Array, element?: EbmlElement): { duration?: number } {
  if (!element) return {};
  const children = collectEbmlElements(bytes, element.dataStart, element.dataEnd);
  const timecodeScale = readEbmlUInt(bytes, children.find((child) => child.id === 0x2ad7b1)) || 1_000_000;
  const duration = readEbmlFloat(bytes, children.find((child) => child.id === 0x4489));
  return { duration: duration === undefined ? undefined : (duration * timecodeScale) / 1_000_000_000 };
}

function parseEbmlTracks(
  bytes: Uint8Array,
  element?: EbmlElement,
): { count: number; codecs: string[]; width?: number; height?: number } {
  if (!element) return { count: 0, codecs: [] };
  const trackEntries = collectEbmlElements(bytes, element.dataStart, element.dataEnd).filter((child) => child.id === 0xae);
  const codecs: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  for (const track of trackEntries) {
    const children = collectEbmlElements(bytes, track.dataStart, track.dataEnd);
    const codec = readEbmlString(bytes, children.find((child) => child.id === 0x86));
    if (codec && !codecs.includes(codec)) codecs.push(codec);
    const type = readEbmlUInt(bytes, children.find((child) => child.id === 0x83));
    const video = children.find((child) => child.id === 0xe0);
    if (type === 1 && video) {
      const videoChildren = collectEbmlElements(bytes, video.dataStart, video.dataEnd);
      width = readEbmlUInt(bytes, videoChildren.find((child) => child.id === 0xb0)) || width;
      height = readEbmlUInt(bytes, videoChildren.find((child) => child.id === 0xba)) || height;
    }
  }
  return { count: trackEntries.length, codecs, width, height };
}

function parseEbmlInfo(bytes: Uint8Array): MediaInfo | null {
  if (bytes.length < 8 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return null;
  const root = collectEbmlElements(bytes, 0, bytes.length);
  const header = root.find((element) => element.id === 0x1a45dfa3);
  const docTypeValue = readEbmlString(bytes, header && collectEbmlElements(bytes, header.dataStart, header.dataEnd).find((e) => e.id === 0x4282));
  const segment = root.find((element) => element.id === 0x18538067);
  const segmentChildren = segment ? collectEbmlElements(bytes, segment.dataStart, segment.dataEnd) : [];
  const info = parseEbmlSegmentInfo(bytes, segmentChildren.find((element) => element.id === 0x1549a966));
  const tracks = parseEbmlTracks(bytes, segmentChildren.find((element) => element.id === 0x1654ae6b));
  const docType = docTypeValue?.toLowerCase().includes("webm")
    ? "WebM"
    : docTypeValue?.toLowerCase().includes("matroska")
      ? "Matroska"
      : "EBML";
  return {
    format: docType,
    codec: tracks.codecs.length > 0 ? tracks.codecs.slice(0, 4).join(", ") : undefined,
    width: tracks.width,
    height: tracks.height,
    duration: info.duration === undefined ? undefined : formatDuration(info.duration),
    tracks: tracks.count || undefined,
    note: docTypeValue ? `EBML DocType ${docTypeValue}` : "已识别 EBML 容器",
  };
}

// ---- 播放列表（HLS / DASH，只解析文本头） ----

function decodeTextHead(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, Math.min(bytes.length, 65536)))
    .trim();
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function parseHlsInfo(bytes: Uint8Array): MediaInfo | null {
  const text = decodeTextHead(bytes);
  if (!text.startsWith("#EXTM3U")) return null;
  const durations = [...text.matchAll(/^#EXTINF:([0-9.]+)/gm)].map((match) => Number(match[1])).filter(Number.isFinite);
  const bandwidth = text.match(/BANDWIDTH=(\d+)/i)?.[1];
  return {
    format: "HLS",
    variants: countMatches(text, /^#EXT-X-STREAM-INF:/gm),
    segments: countMatches(text, /^#EXTINF:/gm),
    duration: durations.length > 0 ? formatDuration(durations.reduce((sum, value) => sum + value, 0)) : undefined,
    bitrate: bandwidth ? `${Math.round(Number(bandwidth) / 1000)} kbps` : undefined,
  };
}

function parseDashInfo(bytes: Uint8Array): MediaInfo | null {
  const text = decodeTextHead(bytes);
  if (!/<MPD[\s>]/i.test(text)) return null;
  const iso = text.match(/mediaPresentationDuration=["']([^"']+)["']/i)?.[1];
  let duration: string | undefined;
  if (iso) {
    const match = iso.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    duration = match
      ? formatDuration(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0))
      : iso;
  }
  return {
    format: "DASH",
    duration,
    variants: countMatches(text, /<Representation\b/gi),
    segments: countMatches(text, /<SegmentURL\b|<S\b/gi),
  };
}

/** 视频入口：按 OFV 的顺序（HLS → DASH → MP4/MOV → AVI → EBML）。 */
export function parseVideoInfo(bytes: Uint8Array, fallbackFormat: string): MediaInfo {
  if (bytes.length === 0) return { format: fallbackFormat, note: "无法读取本地头信息" };
  return (
    parseHlsInfo(bytes) ||
    parseDashInfo(bytes) ||
    parseMp4Info(bytes) ||
    parseAviInfo(bytes) ||
    parseEbmlInfo(bytes) || {
      format: fallbackFormat,
      note: "暂未识别视频头结构",
    }
  );
}

/** `MediaInfo` → 单行状态栏文本（只含有值的字段；`onInfo` 的口径）。 */
export function mediaInfoLine(info: MediaInfo): string {
  const parts: string[] = [info.format];
  if (info.codec) parts.push(info.codec);
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`);
  if (info.sampleRate) parts.push(`${info.sampleRate} Hz`);
  if (info.channels) parts.push(`${info.channels} 声道`);
  if (info.bitDepth) parts.push(`${info.bitDepth} bit`);
  if (info.bitrate) parts.push(info.bitrate);
  if (info.duration) parts.push(info.duration);
  if (info.tracks !== undefined) parts.push(`${info.tracks} 轨道`);
  if (info.variants !== undefined) parts.push(`${info.variants} 变体`);
  if (info.segments !== undefined) parts.push(`${info.segments} 片段`);
  if (info.tags) parts.push(info.tags);
  if (info.note) parts.push(info.note);
  return parts.join(" · ");
}

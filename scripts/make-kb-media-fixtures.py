#!/usr/bin/env python3
"""生成 tests/fixtures/media-info/ 下的媒体容器头夹具（kb-media-info.test.ts 用）。

为什么入库而不是放 /tmp：这些夹具是**按字节手写的最小头**（几百 B），
2026-09 曾放 /tmp 被系统清理丢了导致测试全红——小文件就该进 git，一劳永逸。

每个文件按容器规范构造最小合法头，字段值与测试断言一一对应
（断言的是解析出的具体字段值，字节错一位就会红）。

用法：python3 scripts/make-kb-media-fixtures.py
"""

from __future__ import annotations

import struct
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "media-info"


def u16be(v: int) -> bytes:
    return struct.pack(">H", v)


def u32be(v: int) -> bytes:
    return struct.pack(">I", v)


def u32le(v: int) -> bytes:
    return struct.pack("<I", v)


def u64le(v: int) -> bytes:
    return struct.pack("<Q", v)


def f64be(v: float) -> bytes:
    return struct.pack(">d", v)


# ---- EBML（Matroska）辅助：ID 照抄规范，尺寸按 VINT 编码 ----


def ebml_vint(value: int) -> bytes:
    length = 1
    while value >= (1 << (7 * length)) - 1:
        length += 1
    first = 0x80 >> (length - 1)
    out = bytearray()
    for i in range(length - 1, -1, -1):
        byte = (value >> (8 * i)) & 0xFF
        if i == length - 1:
            byte |= first
        out.append(byte)
    return bytes(out)


def ebml_elem(eid: int, payload: bytes) -> bytes:
    return struct.pack(">I", eid)[4 - (eid.bit_length() + 7) // 8 :] + ebml_vint(len(payload)) + payload


def make_wav() -> bytes:
    fmt = struct.pack("<HHIIHH", 1, 1, 8000, 16000, 2, 16)  # pcm/mono/8k/byteRate/blockAlign/16bit
    data = b"\x00" * 16000  # 16000 B / 16000 B/s = 1s → "0:01"
    body = b"WAVE" + b"fmt " + u32le(len(fmt)) + fmt + b"data" + u32le(len(data)) + data
    return b"RIFF" + u32le(len(body)) + body


def make_flac() -> bytes:
    # STREAMINFO 前 18 字节：块尺寸(2+2) 帧尺寸(3+3) | 采样率20bit 声道3bit 位深5bit 总样本36bit
    # 位深 5bit 值 = 16-1 = 0b0_1111：b[12] 最低位是 MSB(0)，b[13] 高 nibble = 0xF
    streaminfo = (
        u16be(0x1000) + u16be(0x1000) + b"\x00" * 6
        + bytes([0x0A, 0xC4, 0x42, 0xF0, 0x00, 0x02, 0x05, 0x54])  # 44100 / 2ch / 16bit / 132300 样本
        + b"\x00" * 16  # MD5 占位（凑满 34 字节块体）
    )
    # 44100×3s = 132300 → duration "0:03"
    return b"fLaC" + bytes([0x80]) + len(streaminfo).to_bytes(3, "big") + streaminfo


def make_mp3() -> bytes:
    id3_body = b"TIT2" + struct.pack(">I", 6) + b"\x00" + b"kb" + b"\x00"  # 一个极简帧
    header = b"ID3" + bytes([3, 0, 0])  # v2.3.0，无 flag
    synchsafe = bytes([(len(id3_body) >> 21) & 0x7F, (len(id3_body) >> 14) & 0x7F, (len(id3_body) >> 7) & 0x7F, len(id3_body) & 0x7F])
    # MPEG-1 Layer III 128kbps 44100Hz 立体声帧头：FF FB 90 00
    frame = b"\xff\xfb\x90\x00" + b"\x00" * 32
    return header + synchsafe + id3_body + frame


def ogg_page(payload: bytes, granule: int, header_type: int = 0) -> bytes:
    segments = [payload[i : i + 255] for i in range(0, len(payload), 255)] or [b""]
    table = b"".join(bytes([len(s)]) for s in segments)
    return (
        b"OggS" + bytes([0, header_type]) + u64le(granule) + u32le(1) + u32le(0) + u32le(0)  # crc 不校验
        + bytes([len(segments)]) + table + b"".join(segments)
    )


def make_opus() -> bytes:
    head = b"OpusHead" + bytes([1, 2]) + struct.pack("<H", 312) + struct.pack("<I", 48000) + bytes([0, 0])
    return ogg_page(head, granule=0, header_type=2)  # BOS 页；granule 0 → 无时长（测试不断言）


def make_aiff() -> bytes:
    # 44100 的 80-bit 扩展浮点：指数 16383+15=16398(0x400E)，尾数 44100<<48
    rate80 = struct.pack(">H", 16398) + struct.pack(">Q", 44100 << 48)
    # COMM 体 18 字节：声道(2) + 帧数(u32!) + 位深(2) + 采样率(10)
    comm = struct.pack(">H", 2) + u32be(64) + struct.pack(">H", 16) + rate80
    body = b"AIFF" + b"COMM" + u32be(len(comm)) + comm
    return b"FORM" + u32be(len(body)) + body


def make_au() -> bytes:
    data = b"\x00" * 100  # 100/(8000×1×2) ≈ 0.006s → "0:00"
    return b".snd" + u32be(24) + u32be(len(data)) + u32be(3) + u32be(8000) + u32be(1) + data


def make_midi() -> bytes:
    return b"MThd" + u32be(6) + u16be(1) + u16be(16) + u16be(480)  # SMF1 / 16 轨 / 480 tick


def make_aac() -> bytes:
    # ADTS：FF F1 | profile=1(LC→显示2) 采样率索引=4(44100) | 声道高位=2
    return b"\xff\xf1\x50\x80" + b"\x00" * 8


def mp4_atom(kind: bytes, payload: bytes) -> bytes:
    return u32be(8 + len(payload)) + kind + payload


def make_mp4(brand: bytes) -> bytes:
    ftyp = mp4_atom(b"ftyp", brand + u32be(0) + brand)
    mvhd_body = bytes([0, 0, 0]) + bytes([0]) + u32be(0) + u32be(0) + u32be(1000) + u32be(3000)  # v0：1s 精度 3s
    mvhd_body += b"\x00" * 80  # rate/volume/matrix/nextTrackID 占位
    mvhd = mp4_atom(b"mvhd", mvhd_body)
    # tkhd v0 体 84B：宽高在 +76/+80（16.16 定点）
    tkhd_body = bytearray(84)
    tkhd_body[76:80] = u32be(1920 << 16)
    tkhd_body[80:84] = u32be(1080 << 16)
    tkhd = mp4_atom(b"tkhd", bytes(tkhd_body))
    trak = mp4_atom(b"trak", tkhd)
    moov = mp4_atom(b"moov", mvhd + trak)
    return ftyp + moov


def make_avi() -> bytes:
    body = (
        u32le(41666)   # μs/帧
        + u32le(300000)  # maxBytesPerSec → 2400 kbps
        + u32le(0) + u32le(0)  # padding / flags
        + u32le(150)   # 总帧数：41666×150/1e6 = 6.25s → "0:06"
        + u32le(0) + u32le(1) + u32le(0)  # initial / streams / bufferSize
        + u32le(1920) + u32le(1080)
        + u32be(0) * 0 + b"\x00" * 16  # 保留 4 dword
    )
    assert len(body) == 56
    return b"RIFF" + u32le(4 + 8 + len(body)) + b"AVI " + b"avih" + u32le(len(body)) + body


def make_mkv() -> bytes:
    header = ebml_elem(0x1A45DFA3, ebml_elem(0x4282, b"matroska"))
    info = ebml_elem(
        0x1549A966,
        # Duration 单位 = TimecodeScale（默认 1ms）：7000 × 1e6 / 1e9 = 7s
        ebml_elem(0x2AD7B1, u32be(1000000)) + ebml_elem(0x4489, f64be(7000)),
    )
    video = ebml_elem(0xE0, ebml_elem(0xB0, bytes([0x05, 0x00])) + ebml_elem(0xBA, bytes([0x02, 0xD0])))  # 1280×720
    track = ebml_elem(0xAE, ebml_elem(0x86, b"V_MPEG4/ISO/AVC") + ebml_elem(0x83, bytes([1])) + video)
    tracks = ebml_elem(0x1654AE6B, track)
    segment = ebml_elem(0x18538067, info + tracks)
    return header + segment


def make_hls() -> bytes:
    return (
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nindex.m3u8\n"
        "#EXTINF:10,\na.ts\n#EXTINF:8,\nb.ts\n"
    ).encode()


def make_mpd() -> bytes:
    return (
        '<MPD mediaPresentationDuration="PT1H2M3S"><Period><AdaptationSet>'
        '<Representation id="1" bandwidth="800000"/><Representation id="2" bandwidth="2400000"/>'
        "</AdaptationSet></Period></MPD>\n"
    ).encode()


FILES = {
    "a.wav": make_wav,
    "a.flac": make_flac,
    "a.mp3": make_mp3,
    "a.opus": make_opus,
    "a.aiff": make_aiff,
    "a.au": make_au,
    "a.mid": make_midi,
    "a.aac": make_aac,
    "v.mp4": lambda: make_mp4(b"isom"),
    "v.mov": lambda: make_mp4(b"qt  "),
    "v.avi": make_avi,
    "v.mkv": make_mkv,
    "v.m3u8": make_hls,
    "v.mpd": make_mpd,
}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, maker in FILES.items():
        (OUT / name).write_bytes(maker())
    print(f"✅ {len(FILES)} 个夹具已写入 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

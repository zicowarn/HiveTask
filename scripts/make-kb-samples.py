#!/usr/bin/env python3
"""生成知识库预览（OFV 格式面）的**测试样本集**。

为什么要有这个脚本：这些格式（docx / OFD / XPS / EPUB / XMind / SHP / GLB…）手搓样本
成本高、又必须能重复生成——所以样本由脚本产出，而不是往仓库里塞二进制。
**样本不进 git**（默认输出到 /tmp/kb-spike，是本地测试库根）。

能借到真样本就借：`--ofv <open-file-viewer 仓库>` 会把它的 `test-assets/` 与
`doc/public/` 下的真实文件（真 DWG / 真 OFD / 真 Shapefile / 真 PDF / 真 xlsx / KMZ 等）
拷进来。借来的文件只在本地用于测试，**不随本项目分发**（来源与许可见清单里的"来源"列）。

用法：
    python3 scripts/make-kb-samples.py                       # 输出到 /tmp/kb-spike
    python3 scripts/make-kb-samples.py --out /tmp/kb-spike --ofv ~/Downloads/open-file-viewer-main
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import wave
import zipfile
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NS_OFD = 'xmlns:ofd="http://www.ofdspec.org/2016"'

created: list[tuple[str, str, str]] = []  # (相对路径, 测什么, 预期)


def note(path: Path, what: str, expect: str, root: Path) -> None:
    created.append((str(path.relative_to(root)), what, expect))


def write(path: Path, data: bytes | str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
    return path


def zipfile_at(path: Path, parts: dict[str, bytes | str], *, first: str | None = None) -> Path:
    """打 zip；`first` 指定必须排在第一个且不压缩的条目（EPUB 的 mimetype 要求）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        if first and first in parts:
            info = zipfile.ZipInfo(first)
            info.compress_type = zipfile.ZIP_STORED
            zf.writestr(info, parts[first])
        for name, body in parts.items():
            if name == first:
                continue
            zf.writestr(name, body.encode("utf-8") if isinstance(body, str) else body)
    return path


def png(width: int, height: int, pixel) -> bytes:
    """手搓 PNG（zlib + struct），不引第三方库。"""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(
        b"\x00" + bytes(channel for x in range(width) for channel in pixel(x, y)) for y in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


# ─────────────────────────── 文本类 ───────────────────────────


def make_text(root: Path) -> None:
    d = root / "01-文本"
    write(d / "中文说明.txt", "这是一份 UTF-8 中文文本。\n第二行：编码应当显示为 UTF-8。\n")
    note(d / "中文说明.txt", "文本插件 + 编码识别", "代码高亮视图，头部编码 chip 显示 UTF-8", root)

    write(d / "遗留GBK.txt", "这是 GBK 编码的中文文本，用来验证编码探测。\n".encode("gbk"))
    note(d / "遗留GBK.txt", "GBK 编码探测（中文遗留文件）", "正常显示中文，不是乱码；编码 chip 应为 GBK/GB18030", root)

    write(d / "带BOM的CRLF.txt", "\ufeff这是带 BOM 且 CRLF 换行的文本。\r\n第二行。\r\n")
    note(d / "带BOM的CRLF.txt", "BOM + CRLF 标记", "头部同时出现 BOM 与 CRLF 两个 chip", root)

    write(d / "无扩展名", "没有扩展名的纯文本（像 README / Makefile 那样）。\n第二行。\n")
    note(d / "无扩展名", "注册表认领不了、但内容是文本 → 降级纯文本", "显示为纯文本，**不是**「暂不支持」卡片", root)

    write(d / "长文.txt", "".join(f"第 {i} 行：中文长文本，用于滚动与渲染性能观察。\n" for i in range(1, 4001)))
    note(d / "长文.txt", "长文本渲染与滚动", "打开不卡顿，滚动流畅（约 4000 行）", root)

    code = {
        "示例.rs": "fn main() {\n    println!(\"你好，世界\"); // 中文注释\n}\n",
        "示例.ts": "export const 配置 = { 名称: \"知识库\", 版本: 1 } as const;\n",
        "示例.json": json.dumps({"名称": "知识库", "标签": ["中文", "预览"], "版本": 1}, ensure_ascii=False, indent=2),
        "示例.yaml": "名称: 知识库\n标签:\n  - 中文\n  - 预览\n",
        "示例.py": "# -*- coding: utf-8 -*-\ndef 你好(名字: str) -> str:\n    return f\"你好，{名字}\"\n",
        "示例.sh": "#!/bin/bash\n# 中文注释\necho \"你好，世界\"\n",
        "示例.xml": '<?xml version="1.0" encoding="UTF-8"?>\n<根 属性="值"><子>中文</子></根>\n',
    }
    for name, body in code.items():
        write(d / "代码" / name, body)
    note(d / "代码/", "Prism 按需语言加载（rs/ts/json/yaml/py/sh/xml）", "各自语法高亮正确，中文不乱码", root)


# ─────────────────────────── 文档类 ───────────────────────────


def make_docx(root: Path) -> None:
    doc = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文标题：知识库预览测试</w:t></w:r></w:p>
    <w:p><w:r><w:t>正文段落，包含</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:t>与中文标点——以及英文 English mixed。</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段：宋体/黑体等字体在 WebView 里会回退到系统字体。</w:t></w:r></w:p>
    <w:tbl>
      <w:tblPr><w:tblBorders>
        <w:top w:val="single"/><w:left w:val="single"/><w:bottom w:val="single"/><w:right w:val="single"/>
      </w:tblBorders></w:tblPr>
      <w:tr><w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>列二</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>
"""
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>
"""
    parts = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
""",
        "word/_rels/document.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
""",
        "word/document.xml": doc,
        "word/styles.xml": styles,
    }
    p = zipfile_at(root / "02-文档" / "Word-中文.docx", parts)
    note(p, "docx（docx-preview，失败退 mammoth）", "标题/正文/加粗/表格都在，中文不乱码", root)


def make_pptx(root: Path) -> None:
    def slide(title: str, *bullets: str) -> str:
        rows = "".join(
            f'<a:p><a:r><a:t>{t}</a:t></a:r></a:p>' for t in (title, *bullets)
        )
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>{rows}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>
"""

    parts = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>
""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
""",
        "ppt/presentation.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
  <p:sldId id="257" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst>
</p:presentation>
""",
        "ppt/slides/slide1.xml": slide("第一页：项目介绍", "中文要点一", "中文要点二，含 English"),
        "ppt/slides/slide2.xml": slide("第二页：进展", "已完成 80%", "下阶段计划"),
    }
    p = zipfile_at(root / "02-文档" / "PPT-中文.pptx", parts)
    note(p, "pptx（文本视图，不做版面还原）", "能看到每页的标题与要点文字；卡片上写明是文本视图", root)


def make_eml(root: Path) -> None:
    body = """From: 张三 <zhangsan@example.com>
To: 李四 <lisi@example.com>
Subject: =?UTF-8?B?5Lit5paH6YKu5Lu25rWL6K+V?=
Date: Wed, 17 Sep 2026 10:00:00 +0800
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="BOUND"

--BOUND
Content-Type: text/plain; charset=UTF-8

这是纯文本正文（中文）。
--BOUND
Content-Type: text/html; charset=UTF-8

<html><body><h3>这是 HTML 正文</h3><p>含中文与<script>window.__pwned=1</script>脚本（应被清洗）</p></body></html>
--BOUND--
"""
    p = write(root / "02-文档" / "邮件.eml", body)
    note(p, "eml（postal-mime + DOMPurify）", "显示 HTML 正文与中文主题；脚本被清洗（不执行）", root)


def make_epub(root: Path) -> None:
    parts = {
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
""",
        "OEBPS/content.opf": """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>中文电子书测试</dc:title><dc:identifier id="id">kb-sample</dc:identifier></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/figure.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>
""",
        "OEBPS/nav.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li>第一章</li></ol></nav></body></html>',
        "OEBPS/ch1.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章 中文标题</h1><p>这是第一章正文，用来验证章节顺序与中文排版。</p><p><img src="images/figure.png" alt="插图"/></p></body></html>',
        "OEBPS/ch2.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章 中文标题</h1><p>第二章正文：spine 里排在后面，渲染也应排在后面。</p><script>window.__pwned=1</script></body></html>',
        "OEBPS/images/figure.png": png(48, 48, lambda x, y: (min(255, 40 + x * 4), min(255, 90 + y * 3), 180)),
    }
    p = zipfile_at(root / "02-文档" / "电子书.epub", parts, first="mimetype")
    note(p, "epub（zip + OPF spine）", "两章按 spine 顺序显示；插图显示出来；脚本不执行", root)


def make_ofd(root: Path) -> None:
    """OFD：两页，第一页纯中文文本，第二页文本 + 图像（走资源表）。"""
    def content_page(texts: list[tuple[float, float, float, str]], image: tuple[float, float, float, float, str] | None = None) -> str:
        body = "".join(
            f'<ofd:TextObject Boundary="{x} {y} {max(20.0, len(t) * size)} {size * 1.5}" Size="{size}">'
            f"<ofd:TextCode>{t}</ofd:TextCode></ofd:TextObject>"
            for x, y, size, t in texts
        )
        if image:
            x, y, w, h, res = image
            body += f'<ofd:ImageObject Boundary="{x} {y} {w} {h}" ResourceID="{res}"/>'
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page {NS_OFD}><ofd:Content><ofd:Layer>
{body}
</ofd:Layer></ofd:Content></ofd:Page>
"""

    parts = {
        "OFD.xml": f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD {NS_OFD} Version="1.0">
  <ofd:DocBody>
    <ofd:DocInfo><ofd:DocID>kb-sample</ofd:DocID><ofd:Title>中文公文测试</ofd:Title></ofd:DocInfo>
    <ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>
  </ofd:DocBody>
  <ofd:File ID="img1">Doc_0/Res/Image_0.png</ofd:File>
</ofd:OFD>
""",
        "Doc_0/Document.xml": f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document {NS_OFD}>
  <ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>
  <ofd:Pages>
    <ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml" PhysicalBox="0 0 210 297"/>
    <ofd:Page ID="2" BaseLoc="Pages/Page_1/Content.xml" PhysicalBox="0 0 210 297"/>
  </ofd:Pages>
</ofd:Document>
""",
        "Doc_0/Pages/Page_0/Content.xml": content_page(
            [
                (25.0, 25.0, 8.0, "中文公文测试文件"),
                (25.0, 45.0, 4.5, "第一行正文：这是一份用于验证 OFD 预览的样本。"),
                (25.0, 55.0, 4.5, "第二行正文：文本按毫米坐标排版，字号按 Size 还原。"),
                (25.0, 275.0, 3.5, "第 1 页 / 共 2 页"),
            ]
        ),
        "Doc_0/Pages/Page_1/Content.xml": content_page(
            [
                (25.0, 25.0, 8.0, "第二页：含图像对象"),
                (25.0, 45.0, 4.5, "下方图像从 OFD 包内解出并贴到 boundary 位置。"),
                (25.0, 275.0, 3.5, "第 2 页 / 共 2 页"),
            ],
            image=(25.0, 60.0, 60.0, 60.0, "img1"),
        ),
        "Doc_0/Res/Image_0.png": png(96, 96, lambda x, y: (200, min(255, 80 + x * 2), min(255, 80 + y * 2))),
    }
    p = zipfile_at(root / "02-文档" / "OFD-公文.ofd", parts)
    note(p, "OFD（自研解析）", "两页按 A4 尺寸显示，中文文本位置/字号接近原件；第二页图显示出来", root)


def make_xps(root: Path) -> None:
    parts = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/>
  <Default Extension="fdoc" ContentType="application/vnd.ms-package.xps-fixeddocument+xml"/>
  <Default Extension="fpage" ContentType="application/vnd.ms-package.xps-fixedpage+xml"/>
</Types>
""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocumentSequence.fdseq"/>
</Relationships>
""",
        "FixedDocumentSequence.fdseq": '<FixedDocumentSequence xmlns="http://schemas.microsoft.com/xps/2005/06"><DocumentReference Source="/Documents/1/FixedDocument.fdoc"/></FixedDocumentSequence>',
        "Documents/1/FixedDocument.fdoc": '<FixedDocument xmlns="http://schemas.microsoft.com/xps/2005/06"><PageContent Source="/Documents/1/Pages/1.fpage"/><PageContent Source="/Documents/1/Pages/2.fpage"/></FixedDocument>',
        "Documents/1/Pages/1.fpage": """<?xml version="1.0" encoding="UTF-8"?>
<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="816" Height="1056" xml:lang="zh-CN">
  <Glyphs UnicodeString="XPS 第一页：固定版式文档" FontRenderingEmSize="24" OriginX="96" OriginY="96"/>
  <Glyphs UnicodeString="这一行是中文文本，用于验证文本抽取。" FontRenderingEmSize="14" OriginX="96" OriginY="140"/>
</FixedPage>
""",
        "Documents/1/Pages/2.fpage": """<?xml version="1.0" encoding="UTF-8"?>
<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="816" Height="1056" xml:lang="zh-CN">
  <Glyphs UnicodeString="XPS 第二页：只有文本层" FontRenderingEmSize="24" OriginX="96" OriginY="96"/>
</FixedPage>
""",
    }
    p = zipfile_at(root / "02-文档" / "XPS-固定版式.xps", parts)
    note(p, "xps（文本视图）", "两页分别列出文本；顶部说明写明是文本版式视图", root)


def make_xmind(root: Path) -> None:
    content = [
        {
            "id": "sheet1",
            "title": "产品规划",
            "rootTopic": {
                "id": "root",
                "title": "知识库预览",
                "children": {
                    "attached": [
                        {"id": "a", "title": "文档类", "children": {"attached": [{"id": "a1", "title": "Word / PDF"}, {"id": "a2", "title": "OFD 公文"}]}},
                        {"id": "b", "title": "数据类", "children": {"attached": [{"id": "b1", "title": "GIS 矢量"}, {"id": "b2", "title": "CAD 图纸"}]}},
                        {"id": "c", "title": "媒体类"},
                    ]
                },
            },
        }
    ]
    p = zipfile_at(root / "02-文档" / "思维导图.xmind", {"content.json": json.dumps(content, ensure_ascii=False)})
    note(p, "xmind（content.json）", "层级列表还原（中心主题 → 三层分支），中文正常", root)

    # 旧版 XMind（XMind 8 及以前）：content.xml，结构与新版不同但同样有层级
    legacy = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">'
        '<sheet id="s1"><title>旧版画布</title>'
        '<topic id="root"><title>旧版中心主题</title><children><topics type="attached">'
        '<topic id="t1"><title>旧版分支一</title><children><topics type="attached">'
        '<topic id="t2"><title>旧版叶子</title></topic>'
        "</topics></children></topic>"
        '<topic id="t3"><title>旧版分支二</title></topic>'
        "</topics></children></topic>"
        "</sheet></xmap-content>"
    )
    p2 = zipfile_at(root / "02-文档" / "旧版思维导图.xmind", {"content.xml": legacy})
    note(p2, "旧版 XMind（content.xml）", "与新版同流程还原层级；中文正常", root)


def make_drawio(root: Path) -> None:
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net"><diagram name="流程图"><mxGraphModel>
  <root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" value="开始" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="40" as="geometry"/></mxCell>
    <mxCell id="3" value="读取文件" vertex="1" parent="1"><mxGeometry x="40" y="120" width="120" height="40" as="geometry"/></mxCell>
    <mxCell id="4" value="&lt;b&gt;渲染预览&lt;/b&gt;" vertex="1" parent="1"><mxGeometry x="220" y="120" width="120" height="40" as="geometry"/></mxCell>
    <mxCell id="5" edge="1" source="2" target="3" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="6" edge="1" source="3" target="4" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root>
</mxGraphModel></diagram></mxfile>
"""
    p = write(root / "02-文档" / "流程图.drawio", xml)
    note(p, "drawio（顶点框）", "三个方框按坐标显示，标签去掉 HTML 标签；连线不画（已标注）", root)


def make_markdown(root: Path) -> None:
    md = """# 示例文档（Markdown 编辑与实时预览）

这是一份包含 **粗体**、*斜体*、`行内代码` 与中文标点的文档。

## 公式

行内公式 $E = mc^2$，块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

## 表格

| 名称 | 说明 | 数量 |
|:---|:---:|---:|
| 甲 | 左对齐 | 1 |
| 乙 | 居中 | 2 |

## 任务与列表

- [x] 已完成的事项
- [ ] 未完成的事项

## 图表

```mermaid
graph LR
  A[读取文件] --> B{有插件?}
  B -->|是| C[交给插件渲染]
  B -->|否| D[文本或诚实卡片]
```

## 代码

```rust
fn main() { println!("你好，中文"); }
```
"""
    p = write(root / "02-文档" / "示例.md", md)
    note(p, "Markdown 编辑器（T6，不是预览）", "Typora 式就地渲染：表格/公式/图表/任务框都渲染；源码模式可切", root)


def make_spreadsheets(root: Path) -> None:
    script = """
const XLSX = require('xlsx');
const out = process.env.KB_SAMPLES_OUT;   // 注意：`node -e` 下 argv[1] 才是第一个参数，用环境变量最稳
const wb = XLSX.utils.book_new();
const s1 = XLSX.utils.aoa_to_sheet([
  ['名称', '数量', '备注'],
  ['中文条目', 12, '第一张表'],
  ['乙项', 3.5, '含小数'],
]);
const s2 = XLSX.utils.aoa_to_sheet([['公式', '值'], ['合计', { f: 'SUM(1,2)' }]]);
XLSX.utils.book_append_sheet(wb, s1, '中文表一');
XLSX.utils.book_append_sheet(wb, s2, '表二');
XLSX.writeFile(wb, `${out}/多表-中文.xlsx`);
XLSX.writeFile(wb, `${out}/旧版-中文.xls`);
XLSX.writeFile(wb, `${out}/多表-中文.ods`);
"""
    d = root / "02-文档"
    d.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "KB_SAMPLES_OUT": str(d)}
    subprocess.run(["node", "-e", script], cwd=REPO, check=True, env=env)
    for name, what in [
        ("多表-中文.xlsx", "xlsx（SheetJS，多工作表）"),
        ("旧版-中文.xls", "xls（BIFF 旧版二进制）"),
        ("多表-中文.ods", "ods（OpenDocument 表格）"),
    ]:
        note(d / name, what, "工作表 Tab 可切换，中文单元格正常，数字右对齐", root)


def make_csv(root: Path) -> None:
    d = root / "02-文档"
    rows = "名称,数量,备注\n中文条目,12,逗号在引号里 \"甲,乙\"\n乙项,3.5,普通行\n"
    write(d / "表格-UTF8.csv", rows)
    write(d / "表格-GBK.csv", rows.encode("gbk"))
    note(d / "表格-UTF8.csv", "csv（纯文本，不是 zip）", "**必须**落在表格预览（曾因 magic 判定被踢出去）", root)
    note(d / "表格-GBK.csv", "GBK 编码的 csv", "中文表头与内容正常显示", root)


# ─────────────────────────── 数据类 ───────────────────────────


def make_gis(root: Path) -> None:
    d = root / "03-数据"
    write(
        d / "矢量.geojson",
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "properties": {"name": "北京市", "类型": "直辖市"}, "geometry": {"type": "Point", "coordinates": [116.4074, 39.9042]}},
                    {"type": "Feature", "properties": {"name": "上海市", "类型": "直辖市"}, "geometry": {"type": "Point", "coordinates": [121.4737, 31.2304]}},
                    {"type": "Feature", "properties": {"name": "长三角区域", "类型": "区域"}, "geometry": {"type": "Polygon", "coordinates": [[[118.0, 30.0], [122.0, 30.0], [122.0, 33.0], [118.0, 33.0], [118.0, 30.0]]]}},
                    {"type": "Feature", "properties": {"name": "示例线", "类型": "线"}, "geometry": {"type": "LineString", "coordinates": [[116.4, 39.9], [121.47, 31.23], [113.26, 23.13]]}},
                ],
            },
            ensure_ascii=False,
        ),
    )
    note(d / "矢量.geojson", "GIS（leaflet，底图默认关闭）", "要素画出并自动缩放到范围；**底图为空**；点「加载在线底图」后才出瓦片", root)

    write(
        d / "地标.kml",
        """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>天安门</name><Point><coordinates>116.3975,39.9087,0</coordinates></Point></Placemark>
  <Placemark><name>示例多边形</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
    116.3,39.8 116.5,39.8 116.5,40.0 116.3,40.0 116.3,39.8
  </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>
""",
    )
    note(d / "地标.kml", "KML → GeoJSON", "点与多边形都画出；中文名称出现在 tooltip/弹窗", root)

    write(
        d / "轨迹.gpx",
        """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="kb-sample" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>示例轨迹</name><trkseg>
    <trkpt lat="39.90" lon="116.40"><ele>50</ele><time>2026-09-17T08:00:00Z</time></trkpt>
    <trkpt lat="39.95" lon="116.45"><ele>55</ele><time>2026-09-17T08:05:00Z</time></trkpt>
    <trkpt lat="40.00" lon="116.50"><ele>60</ele><time>2026-09-17T08:10:00Z</time></trkpt>
  </trkseg></trk>
</gpx>
""",
    )
    note(d / "轨迹.gpx", "GPX → GeoJSON 折线", "轨迹线画出，范围缩放到轨迹", root)

    write(
        d / "拓扑.topojson",
        json.dumps(
            {
                "type": "Topology",
                "objects": {
                    "示例区域": {
                        "type": "GeometryCollection",
                        "geometries": [
                            {"type": "Polygon", "arcs": [[0]], "properties": {"name": "甲区"}},
                        ],
                    }
                },
                "arcs": [[[116.0, 39.0], [117.0, 39.0], [117.0, 40.0], [116.0, 40.0], [116.0, 39.0]]],
                "bbox": [116.0, 39.0, 117.0, 40.0],
            },
            ensure_ascii=False,
        ),
    )
    note(d / "拓扑.topojson", "TopoJSON → GeoJSON", "区域画出（首尾点闭合）", root)


def make_3d(root: Path) -> None:
    d = root / "03-数据" / "3D"
    # GLB：一个三角形（位置 3×float32 + 索引 3×uint16）
    positions = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    indices = struct.pack("<3H", 0, 1, 2) + b"\x00\x00"
    bin_chunk = positions + indices
    gltf = {
        "asset": {"version": "2.0", "generator": "kb-sample"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 6},
        ],
        "buffers": [{"byteLength": len(bin_chunk)}],
    }
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode()
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    glb = (
        b"glTF" + struct.pack("<II", 2, total)
        + struct.pack("<I", len(json_chunk)) + b"JSON" + json_chunk
        + struct.pack("<I", len(bin_chunk)) + b"BIN\x00" + bin_chunk
    )
    write(d / "模型.glb", glb)
    note(d / "模型.glb", "3D（three，自动取景）", "显示一个三角形；可拖动旋转缩放；信息行给出包围盒与三角面数", root)

    write(d / "立方体.obj", """# 立方体（中文注释）
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3
f 1 3 4
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
""")
    note(d / "立方体.obj", "OBJ 文本模型", "立方体显示，可旋转", root)

    # 二进制 STL：一个三角形
    header = b"kb-sample binary STL".ljust(80, b"\x00")
    tri = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0)
    write(d / "三角面.stl", header + struct.pack("<I", 1) + tri)
    note(d / "三角面.stl", "二进制 STL", "三角形显示（computeVertexNormals 后光照正常）", root)

    write(d / "点云.ply", """ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_index
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2
""")
    note(d / "点云.ply", "ASCII PLY", "三角形显示", root)

    # 明示不支持的 3D 格式（诚实卡片）
    write(d / "不可渲染.fbx", b"Kaydara FBX Binary  \x00\x1a\x00")
    note(d / "不可渲染.fbx", "FBX（本期不做解码）", "诚实卡片提示用默认应用打开，**不是**空白画布", root)


def make_cad(root: Path, ofv: Path | None) -> None:
    d = root / "03-数据" / "CAD"

    # 中文 DXF：GBK 码页 + 中文文字（既有 \U+ 转义也有裸 GBK 字节）+ 块引用 + 标注
    def pair(code: int, value: str | bytes) -> bytes:
        body = value if isinstance(value, bytes) else value.encode("gbk")
        return f"{code:>3}".encode() + b"\r\n" + body + b"\r\n"

    buf = b""
    for code, value in [
        (0, "SECTION"), (2, "HEADER"),
        (9, "$ACADVER"), (1, "AC1015"),
        (9, "$DWGCODEPAGE"), (3, "ANSI_936"),
        (9, "$EXTMIN"), (10, "-20.0"), (20, "-20.0"),
        (9, "$EXTMAX"), (10, "220.0"), (20, "160.0"),
        (0, "ENDSEC"),
    ]:
        buf += pair(code, value)
    # 块定义
    buf += pair(0, "SECTION") + pair(2, "BLOCKS")
    buf += pair(0, "BLOCK") + pair(2, "DOOR") + pair(70, "0") + pair(10, "0") + pair(20, "0")
    buf += pair(0, "LINE") + pair(10, "0") + pair(20, "0") + pair(11, "30") + pair(21, "0")
    buf += pair(0, "LINE") + pair(10, "30") + pair(20, "0") + pair(11, "30") + pair(21, "15")
    buf += pair(0, "ENDBLK") + pair(0, "ENDSEC")
    # 实体
    buf += pair(0, "SECTION") + pair(2, "ENTITIES")
    buf += pair(0, "LINE") + pair(10, "0") + pair(20, "0") + pair(11, "200") + pair(21, "0")  # 底线
    buf += pair(0, "CIRCLE") + pair(10, "160") + pair(20, "110") + pair(40, "25")
    buf += pair(0, "ARC") + pair(10, "60") + pair(20, "110") + pair(40, "30") + pair(50, "0") + pair(51, "120")
    buf += (pair(0, "LWPOLYLINE") + pair(70, "1")
            + pair(10, "0") + pair(20, "40") + pair(10, "60") + pair(20, "40")
            + pair(10, "60") + pair(20, "90") + pair(10, "0") + pair(20, "90"))
    # 样条：4 控制点 3 阶（8 个节点，夹紧）
    buf += (pair(0, "SPLINE") + pair(70, "8") + pair(71, "3")
            + pair(40, "0.0") + pair(40, "0.0") + pair(40, "0.0") + pair(40, "0.0")
            + pair(40, "1.0") + pair(40, "1.0") + pair(40, "1.0") + pair(40, "1.0")
            + pair(10, "90") + pair(20, "20") + pair(10, "110") + pair(20, "70")
            + pair(10, "140") + pair(20, "20") + pair(10, "170") + pair(20, "70"))
    buf += pair(0, "INSERT") + pair(2, "DOOR") + pair(10, "20") + pair(20, "60")
    buf += pair(0, "INSERT") + pair(2, "DOOR") + pair(10, "20") + pair(20, "120")
    # 中文文字：一条用 \U+ 转义，一条直接用 GBK 字节
    buf += (pair(0, "TEXT") + pair(10, "5") + pair(20, "150") + pair(40, "8")
            + pair(1, "\\U+623F\\U+95F4A"))
    buf += pair(0, "TEXT") + pair(10, "80") + pair(20, "150") + pair(40, "8") + pair(1, "中文图纸测试")
    buf += pair(0, "ENDSEC") + pair(0, "EOF")
    p = write(d / "中文图纸.dxf", buf)
    note(p, "DXF 中文（GBK 码页 + \\U+ 转义 + 裸 GBK 字节）", "中文文字正确显示为「房间A」「中文图纸测试」；线/圆/弧/多段线/样条/块引用都画出", root)

    if ofv:
        src = ofv / "doc" / "public" / "samples" / "cad" / "绘图_翁家翌_2016011446_自63.dwg"
        if src.exists():
            shutil.copy2(src, d / "真实图纸.dwg")
            note(d / "真实图纸.dwg", "真实 DWG（libredwg wasm → SVG）", "首次打开会加载 9.5MB wasm（稍慢），然后出图", root)
        for name, what in [("15bias.GDS", "GDS（本期不做的 CAD 格式）"), ("15bias.oas", "OAS（本期不做的 CAD 格式）")]:
            s = ofv / "doc" / "public" / "samples" / "cad" / name
            if s.exists():
                shutil.copy2(s, d / name)
                note(d / name, what, "「暂不支持预览」卡片 + 用默认应用打开（不假装能看）", root)

    for name, src, what in [
        ("蝴蝶.dxf", Path("/Users/mrwang/Downloads/butterfly /butterfly .dxf"), "真实 DXF（44 条 SPLINE，无直线）"),
        ("蝴蝶.svg", Path("/Users/mrwang/Downloads/butterfly /butterfly .svg"), "SVG（CorelDRAW 导出，同图对照）"),
    ]:
        if src.exists():
            shutil.copy2(src, d / name)
            note(d / name, what, "DXF 出蝴蝶轮廓；SVG 正常显示（blob 带 image/svg+xml）", root)


def make_images(root: Path) -> None:
    d = root / "03-数据" / "图片"
    write(d / "色板.png", png(160, 120, lambda x, y: (x % 256, (x + y) % 256, y % 256)))
    note(d / "色板.png", "光栅图（blob 带 image/png）", "正常显示渐变图", root)
    write(
        d / "矢量图.svg",
        """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120">
  <rect x="0" y="0" width="200" height="120" fill="#eef"/>
  <circle cx="60" cy="60" r="36" fill="#4c8bf5" opacity="0.8"/>
  <text x="100" y="108" font-size="14" text-anchor="middle">中文 SVG 标题</text>
  <script>window.__pwned = 1</script>
</svg>
""",
    )
    note(d / "矢量图.svg", "SVG（曾因 blob 无 MIME 而空白）", "正常显示图形与中文；内嵌脚本不执行", root)


def make_media(root: Path, video_src: Path | None) -> None:
    d = root / "04-媒体"
    d.mkdir(parents=True, exist_ok=True)

    # 正弦波 WAV（纯 Python）
    path = d / "音调.wav"
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(12000 * __import__("math").sin(2 * 3.141592653589793 * 440 * i / 44100)))
                for i in range(44100 * 2)
            )
        )
    note(path, "音频（原生 <audio>，2 秒 440Hz）", "可播放；元信息行显示时长 00:02；不联网", root)

    # 中文语音 m4a（say + afconvert，macOS 自带）
    if shutil.which("say") and shutil.which("afconvert"):
        aiff = d / "_tmp.aiff"
        subprocess.run(["say", "-v", "Tingting", "这是一段中文语音测试，用于验证知识库的音频预览。", "-o", str(aiff)], check=False)
        if aiff.exists():
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", str(aiff), str(d / "语音.m4a")], check=False)
            aiff.unlink(missing_ok=True)
            if (d / "语音.m4a").exists():
                note(d / "语音.m4a", "m4a/AAC（WebView 原生解码）", "可播放，中文语音清晰", root)

    # 视频：从本机录像里剪 5 秒（avconvert 是系统自带）
    if video_src and video_src.exists() and shutil.which("avconvert"):
        out = d / "视频片段.mp4"
        r = subprocess.run(
            ["avconvert", "--source", str(video_src), "--preset", "PresetPassthrough",
             "--output", str(out), "--start", "0", "--duration", "5", "--replace"],
            capture_output=True,
        )
        if r.returncode != 0 or not out.exists():
            subprocess.run(
                ["avconvert", "--source", str(video_src), "--preset", "PresetHighestQuality",
                 "--output", str(out), "--start", "0", "--duration", "5", "--replace"],
                capture_output=True,
            )
        if out.exists():
            note(out, f"mp4 视频（取自本机录像前 5 秒：{video_src.name}）", "可播放、可拖动进度；元信息行显示时长与分辨率", root)

    # HLS 播放列表（分片同目录）：给出结构说明即可，能否播放取决于 WebView
    write(d / "说明-HLS.txt", "HLS（.m3u8）需要同一目录下的分片文件；本样本集不含分片。\n可用 ffmpeg 生成：\n  ffmpeg -i in.mp4 -c copy -f hls 播放列表.m3u8\n")
    note(d / "说明-HLS.txt", "HLS 样本说明", "（说明文件，不是播放列表本身）", root)


def make_edges(root: Path, ofv: Path | None) -> None:
    d = root / "05-边界"
    write(d / "空文件.txt", b"")
    note(d / "空文件.txt", "空文件", "不报错（显示为空内容）", root)

    write(d / "空文档.md", b"")
    note(d / "空文档.md", "空 Markdown", "编辑器可输入，不报错", root)

    write(d / "随机二进制.bin", bytes((i * 37 + 11) % 256 for i in range(4096)))
    note(d / "随机二进制.bin", "无插件认领的二进制", "「暂不支持预览」卡片 + 用默认应用打开，**不是**乱码文本", root)

    # 真 PDF 内容、**没有扩展名** → 走 magic 兜底（这是 magic 通道的正牌用例）
    pdf_path = Path("/Users/mrwang/Downloads/河南神马氯碱发展有限责任公司.pdf")
    if pdf_path.exists():
        src = pdf_path.read_bytes()
        write(d / "无扩展名PDF", src[: min(len(src), 200_000)])
        note(d / "无扩展名PDF", "内容是 PDF、**没有扩展名**", "magic 兜底认出来 → 交给 pdf 插件（这才是 magic 通道的用途）", root)
        write(d / "伪装成文本的PDF.txt", src[: min(len(src), 200_000)])
        note(
            d / "伪装成文本的PDF.txt",
            "内容是 PDF、扩展名撒谎说是 .txt",
            "**按扩展名当文本显示（乱码）—— 这是「扩展名优先」规则的已知取舍**，改回正确扩展名即可",
            root,
        )

    write(d / "损坏的压缩包.zip", b"PK\x03\x04" + bytes(64))
    note(d / "损坏的压缩包.zip", "损坏的 zip", "显示可读的错误信息（不静默空白，也不误报「暂不支持」）", root)

    if ofv:
        borrow = {
            ofv / "doc" / "public" / "__zoom-test.pdf": ("PDF-真实样本.pdf", "真实 PDF（OFV 仓库样本）", "正常分页渲染"),
            ofv / "doc" / "public" / "__empty-row-test.xlsx": ("真实表格.xlsx", "真实 xlsx（OFV 仓库样本）", "工作表可切换"),
            ofv / "doc" / "public" / "issue37-repro.ofd": ("真实OFD.ofd", "真实 OFD（OFV issue 样本）", "自研解析能出页面与文字"),
            ofv / "packages" / "core" / "test-assets" / "test.kml": ("样本.kml", "OFV 测试样本 KML", "要素画出"),
            ofv / "packages" / "core" / "test-assets" / "test.gpx": ("样本.gpx", "OFV 测试样本 GPX", "轨迹画出"),
            ofv / "packages" / "core" / "test-assets" / "test.geojson": ("样本.geojson", "OFV 测试样本 GeoJSON", "要素画出"),
            ofv / "packages" / "core" / "test-assets" / "test.topojson": ("样本.topojson", "OFV 测试样本 TopoJSON", "要素画出"),
            ofv / "packages" / "core" / "test-assets" / "test.kmz": ("样本.kmz", "OFV 测试样本 KMZ（zip + doc.kml）", "要素画出"),
        }
        for src, (name, what, expect) in borrow.items():
            if src.exists():
                shutil.copy2(src, d / name)
                note(d / name, what, expect, root)

        # 真 Shapefile 集：解出整组（.shp/.dbf/.prj/.shx）
        shp_zip = ofv / "packages" / "core" / "test-assets" / "pandr.zip"
        if shp_zip.exists():
            with zipfile.ZipFile(shp_zip) as zf:
                zf.extractall(d / "shapefile")
            note(d / "shapefile/pandr.shp", "真实 Shapefile（OFV 样本，含 .dbf/.prj）", "读出要素与属性（属性表按 .dbf 解），自动缩放到范围", root)
            write(d / "shapefile/pandr.cpg", "UTF-8\n")
            note(d / "shapefile/pandr.cpg", "属性表代码页（.cpg）", "读取 .cpg 后属性文字按该编码解（这里声明 UTF-8）", root)


def write_checklist(root: Path) -> None:
    lines = [
        "# 知识库预览测试清单（OFV 全格式）",
        "",
        f"生成方式：`python3 scripts/make-kb-samples.py --out {root}`（脚本在仓库里，可重复生成）",
        "**本目录只用于本地测试，不进 git、不随项目分发**；标「OFV 样本」的文件借自",
        "open-file-viewer 仓库（MIT）的 `test-assets/` 与 `doc/public/`。",
        "",
        "| 文件 | 测什么 | 预期 |",
        "|---|---|---|",
    ]
    for rel, what, expect in sorted(created):
        lines.append(f"| `{rel}` | {what} | {expect} |")
    lines += [
        "",
        "## 使用建议",
        "",
        "1. 用「切换知识库」把根切到本目录，沿目录顺序逐个打开；",
        "2. 每个格式都先看**头部右侧的插件 id chip**（如 `pdf`/`cad`/`gis`）——",
        "   它证明文件是被对应插件接走的，而不是被当成纯文本；",
        "3. 出问题时把预览区的错误原文发出来（错误直接显示在预览区，不是白屏）；",
        "4. 深色主题下再把文档/数据类过一遍（配色 token 的回归）。",
        "",
    ]
    write(root / "测试清单.md", "\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/kb-spike", help="测试库根目录（默认 /tmp/kb-spike）")
    ap.add_argument("--ofv", default=str(Path.home() / "Downloads" / "open-file-viewer-main"), help="OFV 仓库路径（借样本用）")
    ap.add_argument("--video", default=str(Path.home() / "Movies" / "Kaptures" / "BarbossaRevealJS技能应用.mp4"))
    args = ap.parse_args()

    root = Path(args.out).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    ofv = Path(args.ofv).expanduser()
    ofv = ofv if ofv.exists() else None

    make_text(root)
    make_docx(root)
    make_pptx(root)
    make_eml(root)
    make_epub(root)
    make_ofd(root)
    make_xps(root)
    make_xmind(root)
    make_drawio(root)
    make_markdown(root)
    make_spreadsheets(root)
    make_csv(root)
    make_gis(root)
    make_3d(root)
    make_cad(root, ofv)
    make_images(root)
    make_media(root, Path(args.video).expanduser())
    make_edges(root, ofv)
    write_checklist(root)

    print(f"✅ 样本已生成到 {root}")
    print(f"   共 {len(created)} 个条目，清单：{root / '测试清单.md'}")
    if not ofv:
        print("   （未找到 OFV 仓库，跳过了借样本部分：真 DWG / 真 OFD / Shapefile 等）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

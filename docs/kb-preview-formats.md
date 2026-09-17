# 知识库预览：格式清单与实现说明（T8 交付）

> 每个格式的**判定方式、实现来源、离线处理、已知边界**都在这张表里。新增格式的步骤见文末。
> 对照基准：Open File Viewer（`xushanpei/open-file-viewer`，MIT）的 27 个插件（逐文件对照，
> 不引其依赖）。所有渲染器**只读**：编辑一律交给「默认应用打开」。

## 1. 总览

| # | 我们的插件 | 扩展名 | OFV 对应 | 实现方式 |
|---|---|---|---|---|
| 1 | `text` | ~120 种文本/代码（含 `txt/md/json/yaml/...`） | `text` | Prism 高亮，语言组件按需加载 |
| 2 | `pdf` | `pdf` | `pdf` | pdfjs-dist，**资源全本地** |
| 3 | `archive` | `zip` `jar` `war` `apk` | `archive` | JSZip 列表 + 文本条目就地展开 |
| 4 | `email` | `eml` `mime` | `email` | postal-mime + DOMPurify |
| 5 | `word` | `docx` `docm` `dotx` `dotm` | `office` | docx-preview，失败退 mammoth |
| 6 | `sheet` | `xlsx` `xlsm` `xlsb` `xls` `csv` `tsv` `ods` `fods` | `office` | SheetJS（多工作表 Tab；ODF 表格也吃） |
| 7 | `slides` | `pptx` `pptm` `ppsx` `potx` | `office` | 解包 XML 取标题与正文（**文本视图**，如实标注） |
| 8 | `ofd` | `ofd` | `ofd` | **自研**：`OFD.xml → DocRoot → Page → Content.xml`，文本按毫米坐标 + `Size` 定字号 |
| 9 | `epub` | `epub` | `epub` | zip + OPF spine 顺序渲染章节，HTML 过 DOMPurify |
| 10 | `xps` | `xps` `oxps` | `xps` | zip + FixedPage → `Glyphs.UnicodeString` 文本视图 |
| 11 | `xmind` | `xmind` | `xmind` | zip + `content.json` → 层级列表 |
| 12 | `drawio` | `drawio` `dio` | —（我们补的） | `mxGraphModel` → 顶点框（不做连线路由） |
| 13 | `audio` | 19 种（`mp3/wav/flac/m4a/aac/ogg/opus/…`） | `audio` | 原生 `<audio>` + 本地 blob |
| 14 | `video` | 17 种（`mp4/webm/mov/mkv/avi/m3u8/…`） | `video` | 原生 `<video>` + 本地 blob；`m3u8` 走 hls.js **自定义 kb:// loader** |
| 15 | `lrc` | `lrc` | `lrc` | **自研**：时间标签 + 元信息标签解析（纯净/带时间两种视图） |
| 16 | `model3d` | `gltf` `glb` `obj` `stl` `ply` `vrml` `wrl`（`fbx/dae/3ds/usd*/3mf/amf` 明示不支持） | `model3d` | three + OrbitControls；贴图/`.bin` 从同根预读成 data URL |
| 17 | `cad` | `dxf` `dwg` | `cad` + `cad-dwg` | **DXF 自研解析**（LINE/CIRCLE/ARC/ELLIPSE/多段线/**SPLINE（NURBS，de Boor）**/HATCH 边界/DIMENSION/文字；含 `$DWGCODEPAGE` 中文解码）→ SVG；**DWG** 用 libredwg wasm → SVG |
| 18 | `gis` | `geojson` `topojson` `kml` `kmz` `gpx` `shp` | `gis` | leaflet；**底图默认关闭**，矢量要素本地绘制 |

**合计 18 个插件，覆盖 OFV 的 27 个插件能力**（OFV 的 `detect/viewer/fallback/asset/utils`
是基础设施与"万能兜底"，我们对应的是注册表 + `unsupported` 卡片，不需要单独插件）。

## 2. 中文场景逐项处理（硬需求）

| 场景 | 做法 | 出处 |
|---|---|---|
| PDF 中文乱码 | cmaps（169 个 `.bcmap`）+ standard_fonts（16）**全部随包**，路径 `/pdfjs/*` 由自建 Vite 插件映射 | OFV 默认指向 jsdelivr，离线即失效 |
| PDF 在 WKWebView 里加载 | 必须用 **pdfjs 的 legacy 构建**（`legacy/build/pdf.mjs`，自带 core-js polyfill）。常规构建引用 `Iterator` / `Promise.withResolvers`，而 macOS WKWebView 没有 `Iterator` → `ReferenceError: Can't find variable: Iterator`（用户实测）。锁 `pdfjs-dist@4.10.x` legacy，**升级时不要换回常规构建** | 见 AGENTS.md「运行时约束」 |
| Word 中文字体 | docx-preview + mammoth 回退；中文字体族映射到系统字体栈 | OFV 未处理 |
| DXF 中文文字 | 按图纸 `$DWGCODEPAGE`（ANSI_936→gbk / 950→big5 / 932→shift_jis）解码 + `\U+XXXX` 转义还原 | 自研 |
| OFD 公文 | 文本按 `Boundary`（毫米）+ `Size`（毫米字号）还原版面，中文不再叠成一坨 | 自研（参照 OFV ofd 思路） |
| Shapefile 属性中文 | 读同目录 `.cpg` 作为属性表代码页；缺 `.prj` 时明示"按 WGS84 处理" | 自研 |
| 文件名/路径 | 全程 Rust `PathBuf`，不经 URL 编码层；排序 `localeCompare("zh-Hans-CN")` | 见 plan §5.7 |
| KaTeX 公式 | 字体随包（19 个 woff2/woff/ttf 进 `dist/assets`），OFL 1.1 记账 | plan §5.8 |
| 界面字体 | 系统字体栈，**不打包** UI 拉丁字库 | plan §5.8 |

## 3. 离线清单（`grep http(s)://` 的结论）

知识库模块里只剩 3 处 `http` 字面量，逐条说明：

| 位置 | 内容 | 结论 |
|---|---|---|
| `plugins/gis.ts` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | **唯一的联网点**，且只在用户点「加载在线底图」后才请求；默认零请求（有测试守着：默认渲染后容器里 `<img>` 数为 0） |
| `plugins/cad.ts` | `http://www.w3.org/2000/svg` | XML 命名空间标识符，不是网络请求 |
| `editor/ime-guard.ts` | SoloMD 仓库地址 | 版权出处的注释 |

`src/knowledge/**` 内不存在 `fetch(` / `XMLHttpRequest` / `new Image()`（用时是 blob/objectURL）。
三处例外全部在交付说明里标注，没有静默依赖。

## 4. 构建产物与体积（实测，2026-09-17）

| 项 | 体积 | 何时付 |
|---|---|---|
| `dist/pdfjs/`（cmaps + 字体 + wasm） | 3.9 MB | 打开 PDF 时按需请求单个文件 |
| `dist/vendor/libredwg/libredwg-web.wasm` | 9.5 MB | **只在打开 `.dwg`** |
| `three.module` chunk | 732 KB | 只在打开 3D 模型 |
| `hls` chunk | 580 KB | 只在打开 `.m3u8` |
| `xlsx` chunk | 420 KB | 只在打开表格 |
| `pdf` chunk | 464 KB | 只在打开 PDF |
| `libredwg-web` glue chunk | 188 KB | 同 wasm |
| KaTeX 字体（19 个） | 约 1 MB | 首屏（公式要即显） |

全部按需 `import()`，不进首屏 entry。

## 5. 已知边界（不做的部分，逐条明示）

1. **旧版 `.doc` / `.ppt` / `.rtf`**：OLE2 复合文档 + BIFF 二进制，浏览器侧没有可靠纯 JS 解析器可移植 → 落到「用默认应用打开」，不假装能看；
1b. **ODF 的文字/演示（`.odt` / `.fodt` / `.odp` / `.fodp`）**：与 OOXML 是两套容器，docx-preview / mammoth / 本插件的幻灯片解析器都读不了 → **不认领**（走默认应用打开）。ODF **表格**（`.ods` / `.fods`）由 SheetJS 支持，已收；
2. **PPTX/ODP 无版面还原**：只抽标题与正文的**文本视图**，卡片上写明（完整版面需排版引擎，与 OFV 的 `@aiden0z/pptx-renderer` 同级投入，本期不做）；
3. **OFD 的矢量图形（Path）与签章**：需要完整 OFD 渲染栈；文本 + 图像按原坐标还原，其余标注；
4. **XPS 同样不做矢量**：文本视图；
5. **CAD**：不做交互式 WebGL 视图（OFV `cad-webgl`）——只读预览里 SVG 已能缩放看全图，为此引 three + WebGL 栈不划算；INSERT 只展开一层；三维实体/多线/属性文字不绘制（数量计入信息行，不静默）；HATCH 只画边界不还原填充图案。
   **已支持 SPLINE**（最初漏了它，导致"真实图纸打开是空白"——CorelDRAW 导出的图往往只有样条、没有直线）；验收判据：`butterfly.dxf`（44 条样条）解析出的几何范围 24.298 × 24.349，与该文件自述的 `$EXTMIN/$EXTMAX`（24.305 × 24.356）及兄弟 SVG 的 viewBox 一致，见 `tests/kb-preview-cad-real.test.ts`；
   **空白第二次（渲染侧，2026-09-17 用户实测）**：信息行写着「butterfly .dxf · 44 个图元」，画布却是空白。
   真因：插件删掉 SVG 自带的 `width/height`（那是图纸用户单位，26px 见方，太小）后只剩 `viewBox`，
   而 **WKWebView 把「无内在尺寸的 SVG 放在 flex 容器里」算成 0×0** —— 同机 Chromium 会撑满容器，
   所以只在浏览器里验会漏掉；只写 `max-width: 100%` 不够。修法：由样式表显式给
   `width: 100%; height: auto`（`cad.ts` 只负责去属性，尺寸不再由 JS 决定）。
   证据：离屏 WKWebView 探针同页 A/B —— 修复前 `svg rect = 0×0`，修复后 `772×773.5`、线宽 0.86px（WebKit 自截图可见完整蝴蝶线稿）；
6. **WMF/EMF（OFV `drawing`）**：未做（需 `emf-converter` 这类转换器，收益低）；
7. **PSD / HEIC / TIFF（OFV `image` 的三个特殊格式）**：未做，落到默认应用打开；
8. **字体文件元信息（OFV `asset`）**：未做（3258 行的字体解析，为一张元信息卡不值得）；
9. **加密文档**：不做口令弹窗（OFV `encrypted`），直接给"请用默认应用打开"；
10. **HLS**：只支持分片在**同一知识库目录**内的播放列表（`kb://` loader）；分片指向外网的播放列表离线不可用（这是刻意的）。

## 6. 视图辅助能力（声明式）

插件在自己的定义里声明 `tools`，**面板据此决定显示哪些按钮**，新格式接入不用改面板：

| 能力 | 声明 | 插件要实现 | 已接入 |
|---|---|---|---|
| 缩放（放大 / 缩小 / **适应窗口**） | `tools: ["zoom"]` | `zoom(action)` + `ctx.onZoom({percent, fit})` 回报状态 | 图片（面板侧）、CAD、PDF、3D |
| 查找 | `tools: ["find"]` | `find(query, options)` 异步返回 `{total, current}`；`findClear()` | **PDF**（走 pdfjs 文字层）+ **docx/xlsx/pptx/epub/ofd/xps/xmind/drawio/邮件/代码/压缩包**（走共享 DOM 查找 `DomFinder`） |
| 大纲 | `tools: ["outline"]` | `outline`（条目数组）+ `reveal(target)` | PDF（书签树） |
| 页码 / 跳页 | 无需声明：上报 `ctx.onPaging({page,total})` + 实现 `reveal(page)` | 状态栏显示「第 N / M 页」，点它输入页码回车跳转 | **PDF、pptx（页=幻灯片）、OFD、XPS** |

口径约定（所有格式一套口径，不要各写各的）：

- **百分比以「适应窗口」为 100% 的基准**（`ZoomController`）：打开任何视图类文件就是 100%，
  放大/缩小在这条基准上按档位走。*不要*用绝对比例 —— 竖版 PDF 适应后显示 47%、
  要填满宽度得手点到 150%，用户读不懂那个数（实测反馈）；
- 「适应」有**两种口径**，基准由格式决定（`ZoomController` 的 `anchor`）：
  - **适应宽度**（`width`）：横向铺满、竖向滚动 —— **文档类的基准**（PDF 已用）。
    竖版页面在宽面板里"整页适应"会留下两大片空白、字小得没法读（用户实测反馈）；
  - **适应页面**（`page`）：整幅可见 + 四周留 10% 空白 —— **图片 / CAD / 3D 的基准**，
    它们的画面本就该一眼看全；
  - 一个格式声明两种口径（插件里的 `zoomModes: ["width", "page"]`）时，面板把"适应"按钮做成
    **下拉**（当前口径打勾）；只有一种时就是普通按钮；
  - 「适应页面」在宽基准下显示的是相对值（如 55%），不是又一个 100% —— 数字要能读出差别；
- **位图不放大超过自然尺寸**（小图拉满屏只会糊）；矢量（SVG/CAD）允许放大，越放大越清晰；
- 缩放走**重排**（改内联 `style.width`）而不是 `transform: scale` —— 矢量放大后依然清晰，滚动尺寸也对。
  注意：**不能改 SVG 的 width/height 属性**，样式表里的 `.kb-cad-canvas svg { width: 100% }`
  （为 WKWebView 加的兜底）会把它盖掉，"点了放大没反应"就是这么来的；改用内联样式（优先级更高）；
  PDF 因为文字画在 canvas 上，缩放必须**重画**可见页；
- 查找命中存**页坐标**（scale = 1）下的矩形，缩放时只乘比例重画，不重新搜索；
- 中文 PDF 的文字常常**一个汉字一个文字项**，所以查找必须先把文字项拼成行再搜
  （`joinLines()`），否则"搜一个词"永远搜不到；
- HTML 类预览用**共享的 `DomFinder`**（`preview/dom-find.ts`）：把容器里的文本节点拼成一条串、
  记下偏移，再按命中区间回插 `<mark>` —— 跨标签的词（`河<strong>南</strong>`）也能命中；
  清理时拆掉 `<mark>` 并 `normalize()`，DOM 回到查找前的样子。**不用 CSS Custom Highlight API**
  （Safari 17.2+，WKWebView 里不保险）；
- docx 的缩放用 CSS **`zoom`**（布局比例缩放，不改内部断行）；SVG/图片用重排；纯 canvas（PDF）重画；
- **页码分两类**：
  - **真分页**：PDF（pdfjs 的页）、pptx（每张幻灯片一块）、OFD/XPS（每页一块）—— 直接按页面块位置跟踪，
    共用 `preview/paging.ts`；
  - **按版心高度折算**（docx）：docx-preview 只在显式分页符处切页，Word 的真实分页（孤行控制、
    段中不分页…）它复现不了，所以改用"内容高度 ÷ 一页纸高度"折算（`pageAt()`）——与你滚到哪一一对应（自洽），
    但与 Word 打印页码可能有 ±1 出入；**同时用「当前章节」兜住"我在哪"**（章节来自大纲，绝对可靠）。
    这个出入写在文档与交付说明里，不藏着。

## 7. 新增一个格式的步骤

1. 写 `src/knowledge/preview/plugins/<名字>.ts`，导出 `{ id, extensions, matchHead?, headGuarded?, render }`；
2. 在 `src/knowledge/preview/index.ts` 注册一行（`load` 用动态 `import`，`describe` 里写扩展名与 magic 说明）；
3. `matchHead` 只服务 magic 通道；**同名不同容器**的扩展名放进 `headGuarded`，
   别把 `csv`/`geojson` 这类文本格式从自己家里踢出去；
4. 样式加在 `KnowledgePreview.vue` 的 `<style scoped>`，字号只用 token；
5. 测试加在 `tests/kb-preview-batchN.test.ts`：**路由 + 纯函数解析 + 诚实降级**三类各一条，
   造真实样本文件（而不是 mock 掉解析器）。

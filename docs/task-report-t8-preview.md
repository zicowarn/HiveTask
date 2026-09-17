# T8 交付报告：知识库预览全量（OFV 27 插件对齐）

> 日期：2026-09-17　阶段：S3　范围：**只读预览**（编辑一律「默认应用打开」）
> 门禁：`pnpm gate` 全绿（i18n / ESLint / **Vitest 30 文件 189 测试** / vue-tsc+build / Clippy / **cargo 74 测试**）

## 1. 交付内容

| 项 | 结果 |
|---|---|
| 插件数 | **18 个**，覆盖 OFV 的 27 个插件（含其 `detect/viewer/fallback/asset` 对应的注册表与兜底卡片） |
| 格式清单 | `docs/kb-preview-formats.md`（逐格式：判定方式 / 实现来源 / 离线处理 / 已知边界） |
| 测试 | `tests/kb-preview-{registry,batch3,batch4}.test.ts` 共 **38 条**；另有既有 editor/tree/tabs 等测试 |
| 离线 | 知识库模块内 `fetch/XHR/new Image` 为零；3 处 `http` 字面量逐条说明 |
| 许可 | `THIRD-PARTY.md` 更新，**逐个核对 `package.json` 的 license 字段**（不再凭印象） |

## 2. 逐批次

| 批次 | 内容 | 关键决策 |
|---|---|---|
| 基础设施 | 预览注册表：扩展名优先 → `matchHead`（magic）兜底 → 无认领则「暂不支持」卡片 | 插件只拿到 `ctx`（含 `readSibling`），不直接调 Tauri；便于测试与统一沙箱 |
| 1 | 文本/代码（Prism）、PDF、压缩包（JSZip）、邮件（postal-mime + DOMPurify） | PDF 的 cmaps/标准字体/wasm **全本地**（OFV 默认指向 jsdelivr） |
| 2 | Office：docx（docx-preview + mammoth 回退）、表格（SheetJS 多表 Tab）、演示（文本视图）、csv/tsv | 新增 `headGuarded`，修掉「csv 被表格的 zip 头判定踢出去」的真 bug |
| 3 | OFD、EPUB、XPS、XMind、drawio | OFD **自研**：毫米坐标 + `Size` 字号还原版面；`BaseLoc` 相对文档体目录解析（最易踩的坑） |
| 4 | 音视频、LRC、3D、CAD、GIS | 3D 用 three（贴图/`.bin` 预读成 data URL）；CAD 的 **DXF 自研**、DWG 走 wasm；GIS **底图默认关闭** |

## 3. 三个必须记录的问题与修法

### 3.1 生产包里 PDF 中文资源全 404（真 bug，已修）

`vite-plugin-static-copy` 会把**源路径的目录结构接在 dest 后面**：

```
dist/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/*.bcmap   ← 实际落位
dist/pdfjs/cmaps/*.bcmap                                 ← 运行时请求的地址
```

dev 下不易察觉，真机打开中文 PDF 才会整篇乱码。修法：改用**自建 Vite 插件**
（`vite.config.ts` 的 `vendorAssets()`）——URL 前缀怎么定，文件就放哪；dev/preview 走中间件
（带目录穿越防护），build 走整目录拷贝。修后实测：

```
dist/pdfjs/cmaps            169 个 .bcmap   3.9MB
dist/pdfjs/standard_fonts    16 个
dist/pdfjs/wasm              13 个
dist/vendor/libredwg/libredwg-web.wasm   9.5MB
dist/vendor/libredwg/licenses/  LICENSE-GPL-3.0.txt + NOTICE
```

dev 侧 `curl` 复核（端口用完已释放）：cmaps/wasm/许可均 200 且 Content-Type 正确，
`/pdfjs/cmaps/../package.json` 被穿越防护挡下（落 SPA 首页，非 200 文件）。

### 3.2 `matchHead` 语义被用错，`csv`/`geojson` 被自家插件拒收（真 bug，已修）

原实现：扩展名命中后**一律**再过一遍 `matchHead`。而"表格"插件名下有 `csv`（纯文本）、
"GIS"名下有 `geojson`（纯文本）——它们过不了 zip 头检查，于是打开真实 CSV/GeoJSON
会落到"暂不支持"。批次 2 的测试当年用 zip 字节测 csv，把这个问题掩盖了。

修法：注册表把两个通道的语义分开，新增 `headGuarded`：

- 扩展名通道：`headGuarded` 里列出的扩展名才需要过 `matchHead`（如 `pdf`）；
- magic 通道：只在扩展名未命中时用 `matchHead` 认领（无扩展名/改名文件）。

同时补了两条**真实样本**回归测试（真 CSV、真 GeoJSON 文本）。

### 3.3 `libredwg-web` 的许可是 GPL-3.0（不是 MIT）

`@mlightcad/libredwg-web@0.7.10` 的 `package.json` 声明 **GPL-3.0**（我最初按印象写成 MIT，已更正）。
处置：随包附 GPL-3.0 全文 + 来源 NOTICE（`resources/licenses/` → `dist/vendor/libredwg/licenses/`），
并在 `THIRD-PARTY.md` 说明 AGPL-3.0 第 13 条允许结合分发。
**这是全仓库唯一的强 copyleft 第三方件**；不想要它时的退出成本很低——只删 DWG 路径即可
（DXF 为自研解析，不依赖它）。

### 3.4 首次交付后由用户实测暴露的三个集成 bug（已修）

用户第一轮实机试用反馈「svg 和 dxf 好像不行」，查下来是三个独立问题叠在一起：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | **所有注册表格式都不预览**（PDF/Office/OFD/媒体/3D/CAD 全被当纯文本打开） | 面板的 `kind` 兜底写的是 `return "text"`，`kind === 'other'`（注册表分支）成了**死代码** —— 插件单测全绿也没用，因为它们根本没被调用 | 抽出纯函数 `previewKind()`：Markdown → 图片 → **其余一律交给注册表**；补 `tests/kb-preview-kind.test.ts`（11 条）守这条分工 |
| 2 | **SVG 打开是空白** | blob 没带 MIME 类型：PNG/JPEG 还能靠内容嗅探，SVG 在 WebKit 下会被当纯文本 | `imageMimeFor(ext)` 按扩展名给类型（预览面板 + 编辑器内联图片两处），并加测试断言 blob 的 type |
| 3 | **DXF 打开是空白** | 图里全是 **SPLINE**（44 条，一条直线都没有），而解析器把 SPLINE 当"复杂实体跳过" | 实现 de Boor 求值（含 NURBS 权重），另补 HATCH 边界、DIMENSION（跟匿名块）、SOLID/TRACE/3DFACE、POINT、LEADER |

配套加的两层防护（都是"只测插件测不出来"的那类）：

- `tests/kb-preview-wiring.test.ts`（9 条）：**挂载真实面板**，断言选一个文件后确实走到注册表并渲染出对应视图；顺带覆盖"损坏的 zip → 报错而不是空白"「无扩展名文本 → 降级纯文本」「认领不了的二进制 → 不支持的卡片」；
- `tests/kb-preview-cad-real.test.ts`（10 条）：真实图纸验收 —— 几何范围必须与**文件自述的 `$EXTMIN/$EXTMAX`**一致（24.298 × 24.349 vs 24.305 × 24.356），而不是"看起来画出来了"。fixture 是从真实文件里取下的一条真样条（`tests/fixtures/dxf/`）。

修 3 的过程中还揪出一个隐蔽 bug：范围计算原本是**正则扫路径字符串取数字**，而样条求值会产出 `4.4e-16` 这种指数写法，被拆成 `4` 和 `-16` 两个数 —— 一张 24.3 宽的图被算成 26.3。现在优先用顶点数据算范围，兜底正则也改成整体吞掉指数写法。

### 3.5 PDF 在应用里加载即报 `ReferenceError: Can't find variable: Iterator`（已修）

用户实测报错。根因不在我们的代码，而在 **pdfjs 的构建目标**：

- `pdfjs-dist@6`（以及 4.10 的常规构建）直接引用 `Iterator.prototype` 与
  `Promise.withResolvers`；
- 应用跑在 macOS 的 **WKWebView** 上，它的 JS 特性集合与同机 Safari **不一致** ——
  本机 Safari 已是 18.6（有 `Iterator`），但 WKWebView 里**没有**该全局
  → 一加载就抛 `ReferenceError: Can't find variable: Iterator`。

修法：改用官方为较老引擎准备的 **legacy 构建**
（`pdfjs-dist/legacy/build/pdf.mjs` 与 `legacy/build/pdf.worker.mjs`），它自带 core-js
polyfill（会自己装上 `Iterator` 与 `Promise.withResolvers`）。已核对产物：

```
dist/assets/pdf-*.js            403KB  含 target: 'Iterator' 的 polyfill 安装
dist/assets/pdf.worker-*.mjs   2291KB 同 worker 侧也带 polyfill
```

同时把这条教训固化成规则写进 **AGENTS.md「运行时约束」**（引入依赖前先扫
`Iterator` / `Promise.withResolvers` / `Array.fromAsync` / `Object.groupBy` / `Float16Array`
这类新全局；有 legacy 构建的优先用 legacy），并对全部运行时依赖做了一次扫描：
`three` 的 `Float16Array` 有 `typeof` 守卫（安全），`mermaid` 的命中不在实际调用路径上
（既有功能在本机可用），其余干净。

## 4. 中文场景实测点（合成样本已过测试）

| 场景 | 验证方式 | 结果 |
|---|---|---|
| DXF 中文（GBK 图纸） | `$DWGCODEPAGE` → `ANSI_936` → gbk 解码 + `\U+623F\U+95F4` → 「房间」 | ✅ 单测 |
| OFD 公文版面 | 毫米 → px（`96/25.4`）、`PhysicalBox` 页尺寸、`TextCode` 多段拼接 | ✅ 单测 |
| EPUB 章节 | spine 顺序（manifest 顺序不算数）、中文章节文本 | ✅ 单测 |
| LRC 时间轴 | `[00:15.00][01:20.00]` 一行双标签 → 两条 | ✅ 单测 |
| PDF cmaps | 资源按 URL 前缀落位 + dev/生产双通道 curl | ✅ 实测 |
| SHP 属性代码页 | 读同目录 `.cpg` 传给 `parseDbf`；缺 `.prj` 时明示 WGS84 | 代码 + 分支出文案 |
| 真实 CAD 图纸 | `butterfly.dxf`（CorelDRAW 导出，44 条样条）解析范围 24.298 × 24.349，与文件自述 `$EXTMIN/$EXTMAX`（24.305 × 24.356）、兄弟 SVG 的 viewBox 一致 | ✅ 单测（本机存在该文件时）|

## 5. 需要你做的实机形态验证（R3）

我这边只到"门禁绿 + 单测 + 产物核对"，**形态与观感必须真机看一眼**。建议按此清单逐项截图：

1. **PDF（中文）**：打开一份中文 PDF（含 CID 字体）→ 文字不乱码，滚动加载分页正常；
2. **OFD**：打开一份公文/电子发票 OFD → 文本位置与字号接近原件（矢量图形与签章按说明不显示）；
3. **Office**：docx（含中文）、xlsx（多工作表 Tab 切换）、pptx（文本视图卡片有说明）、csv；
4. **媒体**：mp3/mp4 播放器可播；**故意选一个 WebView 解不了的编码**（如 wmv/mkv）→ 元信息行应出现"这个编码 WebView 解不了，请用默认应用打开"；
5. **3D**：`glb` 可旋转缩放；`fbx`/`usdz` → 诚实卡片（不空白）；
6. **CAD**：一份 DXF（含中文文字与块引用）→ SVG 出图、信息行给出图元数与跳过数；一份 DWG → 出图（首次会加载 9.5MB wasm，稍慢）；
7. **GIS**：geojson/kml → 要素绘制、自动缩放到范围、**底图为空**（离线）；点「加载在线底图」后才出现瓦片；
8. **深色主题**：以上各格式在深色下的观感（我已把 leaflet 控件、CAD 画布、代码高亮映射到 token，但仍需肉眼确认）。

发现形态问题按 R3 反馈（截图 + 期望），我这边按"平台形态 → 我们的实现 → 差异"逐项修。

## 5.1 后续补的三项（用户实测后追加）

| 项 | 内容 | 落点 |
|---|---|---|
| **边距** | 内容区原来固定垫 `padding: 14px 16px`，与各插件自己的内边距叠成**双重边距**（PDF 四周多一圈灰边、docx 左缩 28px）。改为**外层不垫、各渲染器自负内边距**：文档类 10–20px，铺满类（PDF/表格/地图/3D/CAD/视频）贴边 | `KnowledgePreview.vue` 的 `.preview-body` / `.hint` / `.code` |
| **缩放** | 视图类缺缩放。新增声明式能力 `tools: ["zoom"]` + 统一控件（放大 / 缩小 / **适应窗口**，中间显示百分比）。**百分比以「适应窗口」为 100% 的基准**（用户口径：打开就是 100%，放大/缩小相对它按档走——绝对比例那套会让竖版 PDF 显示 47%、填满宽度要手点到 150%）。位图不放大超过自然尺寸；矢量允许。「适应」分两种口径：文档类基准 = **适应宽度**（竖版页面在宽面板里铺满横向、竖向滚动；整页适应会留两大片空白、字小到读不了），图片/CAD/3D = **适应页面**（整幅可见）；声明两种口径的格式，面板把"适应"做成下拉并在当前口径打勾。缩放改**内联 style.width**（属性会被样式表的 `width:100%` 盖掉 —— 这正是"DXF 点了放大没反应"的根因）。接入：**图片、CAD、PDF、3D** | `preview/zoom.ts`（`ZoomController`）、`preview/registry.ts`、`plugins/{cad,pdf,model3d}.ts`、面板头部 |
| **Office 的操作区** | 用户问"word 文档的操作部分没有，是没实现还是？"—— **没实现**（当时只做了 PDF）。补：**共享 DOM 查找**（`preview/dom-find.ts`，一次覆盖 docx/xlsx/pptx/epub/ofd/xps/xmind/drawio/邮件/代码/压缩包）+ **docx 缩放**（CSS `zoom`：版式文档不能靠重排，重排会改断行；基准同样是适应宽度）。顺带修：mammoth 回退失败时不再逃逸成 unhandled rejection，改为给"打不开 + 用默认应用打开"的说明 | `preview/dom-find.ts`、`plugins/{office,text,email,archive,ebook,ofd}.ts`、面板 |
| **查找 / 大纲** | 只读预览也能用同一套查找条与大纲侧栏。PDF 接入：`getOutline()` 书签树 → 大纲；文字项**拼行**后全文搜索（中文 PDF 一汉字一项，不拼行搜不到词），命中存页坐标矩形、叠加层高亮、随缩放重画；查找条在只读场景不显示替换 | `plugins/pdf.ts`、`KnowledgeFindBar.vue`（`replaceable`）、面板（`pluginFind`/`pluginOutline`） |

### 5.2 页码与跳页（用户追问后补齐）

- **状态栏**显示「第 N / M 页」，点它变输入框、回车跳转（Esc 取消）——页码是"状态"不是"动作"，
  和行列/编码/体积/字数同处一格最自然；头部留给动作按钮（缩放刚占了位置）。
- 跟踪逻辑抽成 `preview/paging.ts`（rAF 合帧，长文档不拖慢），**只给真分页的格式**：
  **PDF**（pdfjs 的页）、**pptx**（页 = 幻灯片）、**OFD / XPS**（每页一块）。
- **docx 明确不给页码**：docx-preview 的 `breakPages` 只在**显式分页符**处切页，
  DOM 里的"N 页"跟 Word 实际打印页数不是一回事（没分页符的文档就是 1 页）—— 标上去是假信息。
  字流文档要真页码得先有分页引擎。

### 5.3 大纲跳转点了没反应（用户实测，两个真 bug）

用户报「点 PDF 大纲没有跳转效果」。先用他给的那份 PDF 在 Node 里跑了一遍 pdfjs：
**书签与页码解析都是对的**（`一、前言 → 第 2 页`、`2.1.1 基本情况 → 第 4 页`…），问题不在数据。继续查，是两个各自都能单独致命的问题：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 点「大纲」把预览容器**整个换掉**了 | 模板里"有侧栏 / 无侧栏"写成两个 `v-if` 分支、各绑一次 `ref="previewHost"`；Vue 切分支时**卸载旧 div**（插件渲染的页面全在里面）再挂一个新的空 div —— 于是面板里 `holders` 已是游离节点，`reveal()` 滚的是已不显示的旧元素 | 插件预览只保留**一个稳定容器**，侧栏作为它的兄弟节点（flex 行），显隐不再重建容器 |
| 2 | 滚动目标算错 | `scrollToPage` 用 `holder.offsetTop`，而预览容器链上**没有定位祖先**，`offsetParent` 一路退到 `<body>`，拿它当滚动目标必然跳错 | 抽出 `scrollToElement()`（`preview/paging.ts`）：用 **rect 差值**算目标位置，与定位无关；PDF 与 OFD/XPS/pptx 共用一套 |

顺带把当前章节接上了：大纲侧栏现在会按状态栏的当前页**高亮所在章节**（跳转的效果在侧栏上也看得见）。
回归测试 `tests/kb-preview-wiring.test.ts` 里专门造了一个带大纲的假格式，断言"开关侧栏后正文必须仍在"——这条就是为上面第 1 个问题立的。

### 5.4 docx 的大纲与页码（用户追问后补齐）

上一条我说"docx 不给页码"，用户的追问是对的——**不给替代方案等于没解决问题**。补齐了两件事：

- **大纲**：从 `word/document.xml` 抽标题，再按文本顺序映射回渲染出的段落（指针不回退，重复标题不会
  全指到第一个），点击跳转到该标题。**关键坑**：标题级别必须经 `word/styles.xml` 映射 ——
  用户那份真实方案书写的是 `w:pStyle w:val="2"`，级别藏在样式的 `w:name="heading 1"` 里；
  只认 `Heading1` 字面量的实现在真文档上**一个字都抽不出来**（实测那份文档有 119 个标题）。
- **页码**：改成**按版心高度折算**（`pageAt()`：内容高度 ÷ 一页纸高度），与滚动位置一一对应、
  自洽可跳；同时状态栏显示**当前章节**（来自大纲，绝对可靠）。与 Word 打印页码可能有 ±1 出入，
  这一点明写在格式文档里。
- 按钮只在**确实有结构**时出现（没书签的 PDF / 没标题的 docx 不再给空面板入口）。

## 6. 遗留（T8 之外，已入台账）

- **T9 剩余**：拖拽移动、多选；
- **T10**：⌘P 快速打开、全文搜索、TOC、watcher、面包屑、键盘导航；
- **T13 剩余**：按扩展名的「打开方式」覆盖 UI（byExt）；
- **OFV 未做的 5 项**（已在格式清单 §5 明示，非遗忘）：WMF/EMF、PSD/HEIC/TIFF、字体元信息、旧版 doc/ppt、加密文档口令。

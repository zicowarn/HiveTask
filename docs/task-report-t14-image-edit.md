# 任务报告：知识库图片编辑 P0（T14）

- 日期：2026-09-18
- 分支：`feat/pr-module`（本地开发分支，不推送远端）
- 依据：`docs/plan-knowledge-image-editor.md`（选型调研 + 方案）＋ 用户口径「部分操作参考 Markdown 编辑器的头部功能操作栏」
- 性质标注：**自有能力（平台无此物）**——GitHub 无对应形态，非对齐任务（AGENTS.md R2 不适用）；
  但入口全部落在既有动作区，未新造外壳；桌面适配逐处标注见 §3。

## 1. 本轮范围与结论

| 项 | 内容 | 状态 |
|---|---|---|
| 前置调研 | WKWebView 画布能力 / 图标正源 / 保存链路 / 冲突语法，逐项核实后才开工（用户口径「一切条件具备再开始」） | ✅ |
| 后端 | `kb_write_bytes` 补 `expected_mtime_ms` 守卫（覆盖原图的前置条件） | ✅ +1 单测 |
| 画布 | `src/knowledge/draw/`：Canvas2D 零新依赖，八工具 + 撤销 + 缩放 + 文字 IME | ✅ |
| 接线 | 预览头编辑态（内嵌）+ 工具条 + 保存/取消 + 编辑锁 + 冲突条复用 | ✅ |
| 门禁 | `pnpm gate` 六步全绿（i18n 781 键 / ESLint / Vitest / vue-tsc+build / Clippy / cargo test 96 通过） | ✅ |
| 形态验证 | ✅ **用户实机验收通过（2026-09-19）**——当日截图因屏幕锁定未取到（与 T13 轮同因），以用户真机走查代替 | 走查清单见 §6 |

## 2. 实现要点

### 2.1 后端：`kb_write_bytes` 补 mtime 守卫（kb.rs）

- 与 `kb_write_text` 同一语法：`expected_mtime_ms` 不符 → `bail!("文件已被外部修改，请重新打开后再编辑")`
  （前端按 `已被外部修改` 识别并走冲突条）；文件不存在时跳过校验（新建文件无"外部改动"可言）。
- 旧调用方（粘贴插图 `assets.ts`）不传该参数 → `None` → 行为不变（Tauri 对未传字段按 `Option::None` 反序列化）。
- 新单测 `write_bytes_mtime_guard_rejects_stale_overwrite`：mtime 相符放行 / 过期拒绝且**内容不被覆盖** / 显式 `None` 放行。

### 2.2 前端：`src/knowledge/draw/`（五个文件，全部新写）

| 文件 | 职责 | 可测性 |
|---|---|---|
| `session.ts` | 会话状态（工具/颜色/笔宽/字号/undo/redo/dirty）+ 工具表 + 预设表；**模块级单例**（工具条要就地改状态，做 prop 会撞 `vue/no-mutating-props`；前提=知识库单面板工作区） | 复位/工具表有单测 |
| `geometry.ts` | 纯几何：坐标换算 / 矩形规整 / 脏矩形 / 箭头头部 / 文字块包围盒 | 12 条单测 |
| `history.ts` | 撤销栈：**脏矩形 patch**（before/after ImageData）+ **256MB 字节预算淘汰**（全画布快照 4K 一步 33MB 坐不住；至少保留最后一步） | 3 条单测（预算可注入） |
| `DrawCanvas.vue` | 三层画布（work 编辑真相 / overlay 笔画预览 / visible 合成显示）+ 指针交互 + rAF 节流 | 交互需真机 |
| `DrawToolbar.vue` | 面板头工具条（形态语法对齐 MarkdownToolbar：22px 钮/竖线分组/DropdownMenu） | 形态走查 |

**工具语义**：
- 画笔/橡皮 = 自由笔画（overlay 预览，抬起烘进 work）；橡皮 `destination-out`（预览与提交同语义，擦出透明）；
- 直线/箭头/矩形/椭圆 = 拖拽预览、抬起提交；箭头头部 ±32°、长度 `max(8, 笔宽×4)`；
- 马赛克 = 选区降采样（块平均）再放大回贴（12px 块），预览与提交共用同一条 `pixelateFrom`；
- **文字 = DOM textarea 浮层**（不用 canvas 收键盘——会废掉输入法候选窗，IME 教训同 `ime-guard.ts`）；
  Enter 提交前查 `isComposing`，Esc 取消，blur 提交；逐行 `fillText`（行高 1.35×）。

**保存语义**（KnowledgePreview 内）：
- **PNG → 覆盖原图**：`kbWriteBytes(root, rel, b64, imageMtime)`；外部改过 → 冲突条（复用文本保存的 `conflict-bar`
  与三键文案，按钮按 `imageConflict` 分流到图片处理器）；
- **非 PNG → 另存新 PNG**（`edited-<ts>.png`，同目录，kbStat 探重名加序号）：不做「PNG 字节写进 jpg 容器」的错位；
  保存后 `invalidateFileIndex()` + `openFile(新文件)`；
- 导出前先提交文字草稿；`⌘S` / 工具条保存按钮同一入口。

**编辑锁**：编辑期间 `load()` 早退（画面归画布管，刷新按钮在编辑态为诚实 no-op）；
切文件/换根时脏改动先 `confirmAction`（`window.confirm` 在 WKWebView 是坏的——`confirm.ts` 有实测记录），取消则把选择拨回原文件。

### 2.3 缩放

复用 `preview/zoom.ts` 的 `ZoomController`（「适应窗口 = 100%」口径与查看态一致）；编辑态 `allowUpscale: true`
（放大改细节是刚需，位图放大发虚是本性）；`⌘+ / ⌘- / ⌘0(点百分比)` + **⌘/Ctrl+滚轮**；头部缩放控件原位保留、动作路由给画布。

## 3. 形态对照表（Markdown 编辑器 → 图片编辑；③适配逐条标注）

| 项 | Markdown 编辑器形态 | 图片编辑形态 | 结论 |
|---|---|---|---|
| 工具条槽位 | 预览头中段 `.head-toolbar`（flex 1 居中、可横向滚动） | **同槽位**，`DrawToolbar` 替换出现 | 照抄 |
| 工具条形态 | 22px 图标钮 / 组间 1px 竖线 / 悬停 `--bg-hover` | 同 | 照抄 |
| 下拉 | `DropdownMenu`（22px 描边小盒语言选择器规范） | 笔宽/字号两个 DropdownMenu | 照抄 |
| 命令表 | `markdown-tools.ts` 单一事实源 | `draw/session.ts` 的 `DRAW_TOOLS`（工具是选中态，非执行态） | 适配：工具语义不同，不硬塞进 `MARKDOWN_COMMANDS`（避免污染 `ISSUE_TOOLBAR_KEYS`） |
| 脏标记 | 头部 `●` + tooltip「⌘S 保存」 | 同（`drawSession.dirty`） | 照抄 |
| 保存 | ⌘S + 冲突条（重新载入/仍然覆盖） | ⌘S **+ 可见「保存/取消」按钮** | 适配：画布没有 CM6 的"光标在文档里"的持续暗示，给可见主操作；理由=可发现性 |
| 冲突条 | `conflict-bar`（warning 底 + 两动作） | **同一根条**，按钮按冲突来源分流 | 照抄（复用键 `kb.conflictText/Reload/Overwrite`） |
| 缩放控件 | 图片查看态 `.zoom-group` | **原位保留**，动作路由给画布（同口径） | 照抄 |
| 图标 | Octicon `o.*` 族 | Octicon（pencil/arrow-right/square/circle/typography）+ 自绘 `draw.*`（eraser/line/undo/redo/mosaic） | 适配：Octicons 19.11.0 **确无 eraser/minus（unpkg 404×2 实证）**，按图标铁律走自绘族；square/circle/typography 为官方包原路径 |
| 入口 | —（Markdown 无需入口） | 预览头动作区「编辑图片」文字钮（紧邻「用默认程序打开」） | 适配标注：**自有能力，平台无此物**；入口放既有动作区，未新造外壳 |

## 4. 验证证据

### 4.1 门禁（六步全绿）

```
1/6 i18n 键与占位符校验   OK: 781 keys, placeholders aligned
2/6 ESLint                通过（修掉：watcher 未用解构、vue/no-mutating-props×8）
3/6 Vitest                通过（本模块 +15 条，全库含既有全过）
4/6 vue-tsc + vite build  通过
5/6 Clippy                通过（仅既有的 calendar too_many_arguments 警告，非本轮引入）
6/6 cargo test            96 passed, 0 failed（含新增 mtime 守卫用例）
```

### 4.2 新增单测清单（`tests/kb-draw.test.ts`，15 条）

坐标换算×2 / 矩形规整与并集与夹回×3 / 笔画脏矩形×2 / 箭头头部×1 / 文字块×1 / 撤销栈往返·redo 失效·字节预算×3 / 会话复位·工具表·另存命名×3。
（其中 3 处首轮失败均为**测试期望算错**——单点笔画外扩后的取整应为 3px、箭头两翼上下顺序、浮点累计——实现无误，已修正期望。）

### 4.3 WKWebView 兼容性结论（AGENTS.md 运行时约束）

- **零新 npm 依赖** → 无第三方包扫描事项；
- 本模块用到的 Web API 全部为**长周期稳定 API**（2d context / ImageData / getImageData / putImageData /
  drawImage / toBlob / composite / Pointer Events / ResizeObserver / `new ImageData(bytes,w,h)`），
  本机 WKWebView = Safari 18.6 引擎（WebKit 18615，实测读取），无一命中 `Iterator` / `Promise.withResolvers` 等高危面；
- 刻意**不用**：`OffscreenCanvas`、`createImageBitmap`、`roundRect`（新但非必需，保守绕开）；
- `window.confirm` 不用（WKWebView 无实现且恒返回 true——`confirm.ts` 既有实测），确认走 `confirmAction`。

## 5. 边界与已知限制（如实声明）

1. **GIF**：canvas 只取首帧，编辑输出为静态 PNG（另存路径）；
2. **SVG**：进画布即光栅化，输出位图 PNG（另存路径），不回写 `.svg`；
3. **橡皮**= 擦成透明（PNG 语义）；透明区域在深色主题下显示为透出的棋盘底（画布自带 16px 棋盘格）；
4. **无图层/无选区变换/无填充**：P0 口径（计划 §8）；油漆桶/裁剪/旋转列 P1；
5. 编辑态里「刷新」按钮为 no-op（编辑锁设计使然），「用默认程序打开」隐藏（避免与保存语义混淆）。

## 6. 实机走查清单（已于 2026-09-19 由用户真机验证通过）

> 当日屏幕锁定无法 `screencapture`，走查清单交用户执行；用户实测绘图/擦除/保存/另存/确认退出全部通过。
> 过程中发现并修复一个时序 bug：`commitStroke()` 先清 overlay 后 bake，症状 = 脏点/撤销正常但画面与导出
> 永远不变（jsdom 无真实 canvas，门禁覆盖不到像素级时序）；修后用户复验通过。
> 随后追加的查看态三连修（居中 wrapper / 抓取拖拽 / fit 留白 10%→5%）亦经用户实测通过。

1. ⌘5 知识库 → 树里点开任一 **PNG**（如 `src-tauri/icons/128x128.png`）→ 预览头应多出「**编辑图片**」按钮；
2. 点「编辑图片」→ 头部中段出现工具条（8 图标 + 8 色点 + 虚线圈取色器 + 两个下拉 + 撤销重做灰置），
   右侧变「保存 / 取消」，原「编辑图片/用默认程序打开」隐藏，预览体变画布（棋盘格底 + 图片居中适应）；
3. 画笔随手画一笔 → 笔迹即时可见（overlay 预览）、抬起定型；撤销/重做可用、⌘Z/⇧⌘Z 生效、头部出现脏点 `●`；
4. 切「文字」工具点画布 → 出现虚线框输入浮层 → **拼音连打中文** → Enter 上屏（组字不被吞即 IME 过关）；
5. 「保存」→ toast「图片已保存」、退出编辑态、预览刷新为新内容、树里文件大小变化（覆盖原图路径）；
   换一张 **jpg** 走一遍 → 保存后打开的是同目录新文件 `edited-….png`（另存路径）；
6. 编辑中直接点树上别的文件 → 弹确认框（原生 dialog，非网页 confirm）→「取消」回到原文件继续编辑，「放弃修改」切走。

## 7. 许可与致谢

- 零新依赖 → `THIRD-PARTY.md` **无新增条目**；`@primer/octicons` 的 3 条新路径（square/circle/typography）
  与既有同源记账一致（octicons 属 MIT，此前已在账）；自绘图标无许可义务。
- 评估留痕（jspaint/vue-fabric-editor/PaintZ/MarkerOn/tldraw/Excalidraw）见计划文档 §3/§4/§11，此处不重复。

# 任务报告：知识库 workspace（S1 骨架）

- 日期：2026-09-16
- 分支：`feat/pr-module`（本地开发分支，不推送远端）
- 依据：`docs/plan-knowledge-workspace.md`（v6）；台账 `TASK.md`「知识库 workspace」节
- 交付提交：本报告同批

## 1. 本轮范围（S1 骨架 = T1 + T2 + T3 + T4 + T5 的首批）

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 | Rust 文件系统层（`kb.rs`）：根沙箱 / 列目录 / 读文本（编码探测）/ 读字节 / stat / 写文本（保编码） | ✅ 含 6 个单测 |
| T2 | 工作区接线：单面板 `knowledge.workbench` + Octicon 文件族 + 分类/标题两语 i18n + `⌘5` | ✅ |
| T3 | 根切换：store（最近列表 / 失效守卫）+ `SwitchKnowledgeDialog` | ✅ |
| T4 | 文件树 UI：VS Code 度量照抄 + 懒加载 + 选中 + gitignore 灰显 + 缩进参考线 | ✅ |
| T5 | 预览骨架：文本 / Markdown / 图片 + 「用默认程序打开」「在文件管理器中显示」 | ✅（首批格式） |
| T0 | CM6 live-preview spike（中文 IME / Mermaid / KaTeX） | ⏳ 下一轮 |

## 2. 实现要点

### 2.1 Rust：`src-tauri/src/kb.rs`（不引 `tauri-plugin-fs`）

- **根沙箱**：`resolve_in_root()` 归一化相对路径（拒 `..`）→ 已存在路径 `canonicalize`
  后校验前缀（**符号链接指向根外即被拒**），不存在路径校验最近存在祖先后拼回。
- **编码保真**：`chardetng 1.0`（`Iso2022JpDetection::Allow` + `Utf8Detection::Allow`）
  探测 + `encoding_rs` 解码；BOM 三态（UTF-8/UTF-16LE/BE）优先；`kb_read_text` 回传
  `{text, encoding, bom, eol, size, mtimeMs}`；`kb_write_text` **按原编码 + 原 BOM 回写**，
  并按 `eol` 统一换行（CRLF 文件不被改成 LF）。
- **外部改动保护**：`kb_write_text` 带 `expectedMtimeMs`，不符即拒绝覆盖。
- **原子写**：同目录临时文件 + `rename`，避免半截文件。
- **忽略/排除**：内置排除表（`.git` / `node_modules` / `target` / `dist` / `.DS_Store` …）
  默认隐藏；`.gitignore` 命中用**已有 git2** `is_path_ignored()` 标记为 `ignored`（前端灰显，不隐藏）。
- **大文件**：`kb_read_bytes` 超 32MB 直接拒绝（前端引导「用默认程序打开」）；
  字节流走 `tauri::ipc::Response`（避免 `Vec<u8>` 走 JSON 数组）。

单测（`kb_tests`，6 个）：沙箱越界（`..` / 绝对路径 / 符号链接逃逸）、GBK 解码 + 回写字节一致、
UTF-8 BOM + CRLF 保持不变、过期 mtime 拒绝覆盖、目录排除与 gitignore 标记、二进制/目录读取拒绝。

### 2.2 前端

- `src/workbench/workspaces.ts`：`knowledge` 插在 `projects` 与 `tools` 之间，`listPanel === detailPanel`
  = **单面板**（同「项目」）→ 工作台布局层零改动，面板不会被类型切换器换掉/拆开/关掉。
- `src/knowledge/KnowledgeWorkbench.vue`：`PanelShell` + **内部 `SplitPane`**（左树右预览，
  比例持久化在 `hivetask.kb.treeRatio`，默认 0.23 ≈ 300px，拖拽下限 0.12）。
- `src/knowledge/KnowledgeTree.vue` + `KnowledgeTreeNode.vue`：懒加载（展开才拉）、
  目录在前 + `localeCompare("zh-Hans-CN", {numeric:true})` 排序、gitignore 灰显、
  空态/根失效/错误三态提示。
- `src/knowledge/KnowledgePreview.vue`：图片（字节流 + object URL，卸载时 revoke）、
  Markdown（暂用 `MarkdownView`，S2 换编辑器）、文本（等宽 pre）、其它格式给诚实卡片 + 两个出口。
- `src/stores/knowledge.ts`：根 + 最近列表（localStorage，与 `repo.ts` 的 `recentRepos` 同构）、
  目录缓存 / 展开 / 选中、`probeRoot()` 失效守卫、**`VITE_AUTO_KB` 开发便利项**（同 `VITE_AUTO_REPO` 先例）。
- `src/knowledge/open-path.ts`：`openPath` / `revealItemInDir`（Tauri 走 opener 插件，浏览器预览降级为 no-op）。
- `src-tauri/capabilities/default.json`：新增 **`opener:allow-open-path`**（`opener:default` 不含
  `open_path`，已从 `gen/schemas/acl-manifests.json` 核实）。
- `src/App.vue` / `src/menu-defs.ts`：`gotoKnowledge` + `⌘5`（原生菜单与 webview keydown 两处都加）。

## 3. 验收证据

### 3.1 门禁

`pnpm gate` **全绿**（i18n 514 键 / ESLint / Vitest / vue-tsc + vite build / Clippy / cargo test 62 通过）。

### 3.2 实机截图（`pnpm tauri dev`，`VITE_AUTO_KB=/Users/mrwang/workspace/HiveTask`）

证据目录：`.playwright-mcp/kb-evidence/`（该目录在 `.git/info/exclude` 内，不入 git）

| 文件 | 内容 |
|---|---|
| `kb-01-boot.png` | 启动：页签栏出现「知识库」（项目与工具之间） |
| `kb-02-tab.png` | `⌘5` 切到知识库：面板头 `知识库 ▾` + `切换知识库`；树根行 `HiveTask ⌄`；`node_modules`/`.git` 已隐藏；`TASK.md`/`HANDOFF.md` 灰显（gitignore 命中） |
| `kb-03-expand.png` | 展开 `.dsh` / `.zcode`：缩进参考线可见（1px，对齐祖先箭头列） |
| `kb-06-md.png` | 展开 `docs` 并选中 `plan-knowledge-workspace.md`：预览头显示 `41.5 KB` + `UTF-8` 芯片；Markdown 正常渲染；选中行高亮 |
| `kb-07-dialog.png` | 「切换知识库」对话框（浏览器预览截图）：最近列表空态 + 「选择文件夹…」+ `.gitignore` 开关 |
| `vscode-explorer.png` | 参照：VS Code Explorer（打开本仓库，含缩进参考线与 git 状态角标） |

### 3.3 形态对照表（VS Code → 本实现）

| 项 | VS Code 实测 | 本实现 | 结论 |
|---|---|---|---|
| 树行高 | 22px | 22px | 一致 |
| 展开箭头单元格 | 16px 宽 / `font-size:10px` / `padding-right:6px` / `translate(3px)` | 16px 宽 + `translate(3px)`，图标用 Octicon chevron（14px，符合本仓库图标规范） | 尺寸一致；字形改 Octicon（②照抄 + 图标铁律） |
| 缩进步长 | `workbench.tree.indent` 默认 **8px** | `padding-left: 2 + depth*8` | 一致 |
| 缩进参考线 | 1px、`left:16px` 起、每 8px 一条、`opacity` 过渡 | 1px、左移到 **18px**（=2 行内边距 + 16 箭头单元格，对齐祖先箭头列）、每 8px 一条 | 起点微调（③适配，附理由） |
| 图标 | 16×16（Seti 主题彩色） | Octicon 通用 `file` / `file-directory-fill` / `file-directory-open-fill` / `file-symlink-file`（单色） | 有意不同（③适配：仓库图标铁律要求 Octicon，GitHub 文件树同样是通用图标） |
| 行内边距 | 左 2px | 左 2px | 一致 |
| 悬停/选中 | `list.hoverBackground` / `activeSelectionBackground` | `--bg-hover` / `--bg-selected` | 颜色改用本仓库 token（③适配） |
| 根行 | 树的第一行（可折叠） | **移到面板头**（`知识库 ▾` + 面板级 `切换知识库`） | 有意不同（③适配：根可切换且与面板同寿命，放头部避免与文件行混淆；SoloMD 同做法） |
| 忽略文件 | 资源管理器不灰显（SCM 才显示状态字母） | 灰显（`opacity .55`） | 有意不同（③适配：知识库没有 SCM 视图，灰显是唯一"弱化"通道） |

### 3.4 未在实机点到的部分（浏览器预览已验证）

实机窗口内用 AppleScript `click at` **无法触发 WKWebView 里的 `<button>`**（点树行 div 可以，
点面板头按钮无效）——这是取证手法的限制，不是实现问题。因此：
- 「切换知识库」对话框与 Editor 类型切换器弹层改在**浏览器预览**用 Playwright 验证：对话框正常打开
  （`.kb-panel` 存在）、切换器分类为 `Issues / Pull Requests / 项目 / 知识库 / 工具 / 通用`，
  条目含「知识库」（位置正确）。浏览器控制台除 favicon 404 与关服后的 HMR 重连外无错误。

## 5. S1 补丁：入口归位 + 多标签文件页签（用户反馈后修订）

用户指出三处，已按此改：

1. **「切换知识库」归位到 App header**——与「切换仓库 / 切换项目」**同位置同形态**：
   - 头部按钮区新增分支 `v-else-if="activeKey === 'knowledge'"`：有根时显示「切换知识库」，
     无根时显示「选择文件夹…」；点开的是与另两个切换器**共享的 overlay + panel 外壳**
     （`SwitchKnowledgeDialog` 改造成内容组件，遮罩/标题/关闭由 App.vue 统一渲染）。
   - 头部信息区（`repo-box`）在知识库工作区显示**根文件夹名 + 完整路径**；无根时显示「未选择知识库」。
2. **面板头左侧改为文件页签**（照「项目」面板的视图页签形态：选中态 = 面板底色 + 上/左/右 1px 描边、
   字重 600、悬停底色）：新增 `src/knowledge/KnowledgeTabs.vue`，落在 `PanelShell` 的 `#switcher` 槽；
   点树里的文件即开页签（去重、保序），关闭激活页签落到右邻（无则左邻），页签过多横向滚动。
   store 增加 `tabs` / `closeTab`，`select()` 改为"开页签 + 激活"。
3. **原位置按钮改为「刷新」**：面板头 `#actions` 现在是「刷新」= 重读整棵树（含已展开分支）
   + 让预览重读当前文件（`reloadTick` 传递）。
   > 备选是「默认程序打开」：没选它是因为该动作**属于文件**、已在预览头（有明确对象时才有意义）；
   > 若你更想在这里放它，一行可换。

**验证**：`pnpm gate` 全绿；新增 `tests/knowledge-tabs.test.ts`（5 条：开页签去重保序、
关闭激活页签的落点、关闭非激活不影响当前、关完回空态、换根清空页签与展开态）；
浏览器预览截图 `kb-12-layout.png` 确认头部按钮（「选择文件夹…」/「未选择知识库」）与面板头「刷新」就位。

⚠️ **实机截图欠账**：本轮多次尝试截真窗口均失败——每次都拍到宿主窗口/其它应用
（`frontmost` 校验通过后、`screencapture` 执行前焦点又被抢回）。**用户已自行截图并确认页签形态**（见下节）。

## 6. S1 补丁 2（用户实机截图反馈）

用户在真机截图里发现一处排版缺陷，已修：

- **「刷新」按钮文字被挤成两行**（"刷"在上、"新"在下）。根因：面板头左侧的页签条占位后，
  右侧动作区（`.panel-header-right`）被 flex 压缩，按钮内文字换行。
  修法：`.panel-header-right` 与 `.panel-actions` 加 `flex: none`（右侧动作不可被挤），
  `.text-btn` 加 `white-space: nowrap`（含预览头的「用默认程序打开」）。
  证据：局部放大截图 + 视觉模型复核（"刷"在上、"新"在下）。
- **头部路径冗余**：知识库信息区原本显示「根名 + 完整路径」，与仓库/项目两个盒子不同源。
  新增 `shortPath()`（`src/origin.ts`，与既有 `shortOrigin` 同思路）：把用户主目录折叠成 `~`
  （`/Users/x/work/docs` → `~/work/docs`），完整路径保留在 tooltip。

**用户实机截图确认（2026-09-16）**：页签条形态成立——`知识库 ▾` 之后依次是 8 个文件页签
（`.prettierignore` / `.prettierrc.json` / `eslint.config.js` / `LICENSE` / `README.md` /
`HANDOFF.md` / `AGENTS.md` / `pnpm-lock.yaml`），Markdown 页签用 `markdown` 图标、其余用 `file` 图标；
选中页签（`pnpm-workspace.yaml`）为面板底色 + 描边、字重 600；树中对应行高亮；
预览头显示 `pnpm-workspace.yaml` + `191 B` + `UTF-8` 芯片 + 「用默认程序打开」；
头部显示「HiveTask ~/workspace/HiveTask」+「切换知识库」。页签条在 8 个页签下未挤压右侧动作区。

## 7. S1 补丁 3（第二轮实机反馈：页签条与状态栏）

| 反馈 | 处置 |
|---|---|
| 页签区**没有边界 / 看不出边界** | 页签条自成一条**带底色的横带**（`--bg-app`，与面板内容区分），页签之间加 1px 分隔线；激活页签压住面板头的分隔线，与内容区连成一体 |
| **看不出哪个文件正在打开** | 激活页签改为：面板底色 + 三面 1px 描边 + **顶部 2px 强调线** + 字重 600；页签溢出时右侧额外显示**当前文件名**（页签被卷走也能看到） |
| **左右加方向按钮，按情况显示** | 溢出时（`scrollWidth > clientWidth`）才出现 `‹`/`›` 两个按钮，且**只在对应方向还有内容时**显示；点击平滑滚动；切换文件时自动把激活页签滚入视野 |
| **下部两个 header 偏高** | 树头与预览头由 44px → **34px**（面板头仍 44px，与外层一致） |
| **左侧"筛选"按钮已不需要；补第二个图的按钮** | 树头原来的两个图标（`o.sync` / `o.fold`——`fold` 那枚圆点+箭头确实像漏斗）替换为 **VS Code 资源管理器头部的四枚原图标**：新建文件 / 新建文件夹 / 刷新 / 折叠全部（`@vscode/codicons`，CC BY 4.0，已记账） |
| **状态栏显示光标位置 / tab 尺寸 / 换行 / 编码 / 文件类型** | 状态栏右侧新增知识库段：**文件类型（语言）+ 编码 + 换行（LF/CRLF）+ 大小**。⚠️ **光标行列与制表位暂缺**——它们必须由编辑器提供，当前是只读 `<pre>` 预览；等 T6 的 CM6 落地后补在同一格 |

**配套实现（"新建文件/文件夹"不是空控件）**：Rust 新增 `kb_create`（同名校验、`create_new` 并发安全、越界拦截、中文名可用，+1 单测）；
前端 `KnowledgeCreateDialog`（名称输入 + Enter 提交 + 「创建」）、store 的 `createEntry()`（落点 = 选中目录内部 / 选中文件的父目录 / 根，
建完刷新父目录、展开并选中新条目）。快捷键不额外发明——沿用 VS Code 的"在树里建"语义。

## 8. S1 补丁 4（第三轮实机反馈：页签去冗余与简洁化）

| 反馈 | 处置 |
|---|---|
| 「当前打开的内容」在右端**重复了一遍** | 删除页签条右端的当前文件名（`.active-name`）——激活态由页签自身表达即可 |
| 激活页签的**顶部高亮条多余**（加粗已经够） | 去掉顶部 2px 强调线（连同三面内描边与"压住分隔线"的画法） |
| 页签**改圆角、走简洁风**（对齐项目风格） | 页签 = 圆角 6px 小片：无描边、无分隔线、无强调条；悬停 `--bg-hover`、选中 `--bg-chip` + 字重 600；页签条不再自带宽底色横带 |

## 9. S1 补丁 5（第四轮实机反馈：左侧间隙）

- **现象**：页签条左侧的 `‹` 方向按钮贴着 `知识库 ▾`（Editor 切换器）边框，两者没有间隙。
- **处置**：`.tabs-wrap` 加 `margin-left: 6px`（父级 `panel-header-left` 的 gap 8px 之上）→ 切换器与页签条之间
  **共 14px**；页签条内部间距 6px → 8px，使"按钮↔页签"与"切换器↔按钮"两侧视觉对称。
- 说明：截图经视觉模型测量，左侧间隙约 4px、右侧约 10–12px（明显不对称），与 CSS 预期的 8 / 14 不符——
  以实机观感为准，直接把左侧抬到 14px。
- **牵连**：这是知识库页签条自身的间距，`PanelShell` 的通用 gap（8px）未动，其它面板不受影响。

## 10. S1 补丁 6（第五轮实机反馈：树头归位 + 设置入口 + 图标间距）

| 反馈 | 处置 |
|---|---|
| 根行 `HiveTask ⌄` 的下拉与 App header 的「切换知识库」**功能重复** | 根标识改为**纯展示**（图标 + 名称，无按钮语义、无下拉箭头、无指针）——切换入口只保留 App header 一处 |
| **保留「显示隐藏信息」的设置功能**，并可考虑加入查找/过滤 | 树头右侧新增 **「⋯」视图菜单**（本项目原语 `ActionMenu`）：<br>· 「显示被忽略的文件」——从切换对话框**迁移**至此（原位置的开关已移除，功能保留）<br>· **「过滤…」——本轮实做**：菜单打开树头下方的过滤条（放大镜 + 输入 + 清除），按**名称或路径**实时过滤；过滤态下含命中后代的目录自动展开；空结果显示提示；Esc/清除退出<br>· 说明条注明口径：**仅匹配已展开的条目**（未展开目录只按自身名称参与匹配）<br>· 「查找（全文搜索）」留给 T10，**暂时不摆空控件** |
| 折叠箭头与文件夹图标**贴太紧** | `.ficon` 加 `margin-left: 3px`（箭头与文件夹图标之间约 5–6px） |

**同时修掉页签条间隙的真因**（前两轮没修到位）：`EditorSwitcher` 的根元素原为 `min-width: 0`（可被压缩），
在页签条溢出、头部空间紧张时被压扁，**按钮溢出自身盒子**把 8px 间隙吃掉——实机看起来就是"贴着"。
改法：`.editor-switcher { flex: none }`（切换器永不压缩）+ `.panel-switcher { flex: 1 1 auto }`（页签条优先吸收空间）。
**确定性验证**（浏览器预览 + Playwright，注入 1600px 宽占位内容模拟页签溢出）：切换器盒宽 == 按钮宽（未压缩），
切换器与页签槽间隙 = 8px（父级 gap），页签槽自身滚动而非挤压邻居。知识库页签条再加 `margin-left: 6px` → 实际视觉间隙 14px。

## 11. S1 补丁 7（第六轮实机反馈：⋯ 菜单字号不合规）

**问题定位（实测，非印象）**：把 ⋯ 菜单打开后用浏览器预览量了三处计算样式——

| 元素 | 改前实测 | 规范归属 |
|---|---|---|
| 菜单**条目** | **14px**（`--font-lg`） | AGENTS.md 五档表里「**下拉**」属于 `--font-md` = **12px**（默认 UI 文本档）；`--font-lg` 是"平台对齐档"（GitHub 表格/输入照抄用） |
| 组标题「视图」 | 12px / 600 / dim | 与「组头次级 = md」一致 ✓ |

**根因**：`ActionMenu` 是按 GitHub Actions 菜单**实测形态**做的（14px / 32px 行），所以它是"平台对齐"档；
我把它拿来承载**桌面原生**的视图菜单（非平台对齐），字号档位就串了。

**改法（不动既有平台对齐用法）**：给 `ActionMenu` 增加 `size` 属性——
`platform`（默认，14px/32px 行，看板等平台照抄菜单继续用）/ `ui`（12px = `--font-md`、26px 行，
组标题保持 12px/600/dim 且左右内边距对齐）。知识库 ⋯ 菜单用 `size="ui"`。
改后实测：组标题 **12px/600**、条目 **12px/400**、行高 26px —— 与规范"下拉 = md"一致。

## 12. S1 补丁 8（第七轮：知识库各处字号系统核对）

按 AGENTS.md「字号与图标规范」逐处核对，**依据是项目里同类元素的既有档位**（不是凭感觉）：

| 位置 | 改前 | 依据（项目同类元素 / 规范） | 处置 |
|---|---|---|---|
| 树行（文件 / 目录名） | **14px**（`--font-lg` 平台对齐档） | `IssueRow` 列表主文本 = **13px**；VS Code 资源管理器本身也是 13px | → `--font-base`（13px） |
| 文件页签 | **12px** | `ProjectPanel` 的视图页签 = **13px**（同类必须同档） | → `--font-base`（13px） |
| 树头根标识 | 12px/600 | 规范「组头名称 = base/600」 | → `--font-base`（13px/600） |
| 过滤说明行 | 10px（`--font-xs` 徽标档） | 说明文字属「次级元信息 = sm」 | → `--font-sm`（11px） |
| 预览头文件名 | 13px/600 | 规范「内容主文本 = base + 600」 | 保持 ✓ |
| 编码 / 大小芯片 | 10px（`--font-xs`） | 规范「chip / 角标 = xs」 | 保持 ✓ |
| 空态 / 提示文字 | 11px（`--font-sm`） | 规范「次级元信息 = sm」 | 保持 ✓ |
| ⋯ 菜单条目 | 12px（`--font-md`） | 规范「下拉 = md」 | 保持 ✓（见 §11） |

**验证（浏览器预览实测计算样式）**：`--font-{xs,sm,md,base,lg,xl}` = 10/11/12/13/14/17 ✓；
树头根标识 13px、空态提示 11px、Editor 切换器 12px、状态栏格 11px —— 与上表一致；
`src/knowledge/**` 与 `StatusBar.vue` 中**无裸像素字号**（grep 为空）。

## 13. T13：「打开方式」设置 + 修 `ForbiddenPath`（本轮）

### 13.1 修的 bug（已实证，非推测）

「用默认程序打开」走的是 `@tauri-apps/plugin-opener` 的前端 `openPath`，而该命令**内部强制 ACL scope 校验**：
`commands.rs` → `scope.rs::is_path_allowed` → `tauri::fs::Scope::is_allowed`，而**空 allow 列表 = 全拒**
（`any(matches)` 无 pattern 即 false）。Tauri 的 fs scope 是**编译期静态**配置，表达不了"用户自选的知识库根"，
所以那条路径必然返回 `ForbiddenPath`。**对照：`reveal_item_in_dir`（在文件管理器中显示）的命令实现里没有 scope 校验**，
一直可用——这也解释了为什么只有一个按钮坏。

### 13.2 改法

| 层 | 内容 |
|---|---|
| `kb.rs` 新增 `kb_open_external(root, rel)` | 复用 `resolve_in_root` 根沙箱（文件必须落在知识库根内）→ 从 app.db 读偏好解析应用 → Rust 侧调 `OpenerExt::open_path(path, with)`（**Rust 侧不经 ACL**）。**前端不能指定要启动的程序**——否则「打开文件」会变成任意程序启动的入口 |
| `kb.rs` 新增 `kb_open_prefs_get` / `kb_open_prefs_set` | 偏好存 **app.db 的 `prefs` 表**（新增迁移 `app_007_prefs.sql`，`user_version` 6→7）——打开动作由 Rust 执行，配置就该由 Rust 持有 |
| `kb.rs` 新增 `kb_pick_app` | 原生选择器挑应用（macOS `.app` / Windows `.exe` / Linux 可执行文件），与 `pick_repo`/`kb_pick_root` 同构 |
| `api.ts` / `open-path.ts` / `KnowledgePreview.vue` | `openPathWithConfiguredApp(root, rel)` 走新命令；预览头两个按钮（含不支持格式的卡片）改接；失败时把错误显示在预览区（可诊断） |
| `SettingsBasicMode.vue` | 新增「打开方式」行：应用名输入（回车/失焦提交，留空 = 系统默认程序）+「选择应用…」按钮 |

### 13.3 顺手加固（由测试发现）

写测试时发现 `resolve_in_root(root, "/etc/passwd")` **并不会被拒**：`normalize_rel` 会把前导斜杠去掉，
于是绝对路径被**静默当成根内相对路径**（`<root>/etc/passwd`）。虽仍在根内（没逃逸），但与函数文档"拒绝绝对路径"不符，
且语义危险（调用方以为传的是绝对路径）。已改为**显式拒绝**：前导 `/`、前导 `\`、盘符前缀（`C:`）三种形态直接报错。

### 13.4 验证

- **Rust 单测 66 通过**（kb 模块 10 条，本轮新增 3 条）：扩展名覆盖优先于默认应用、大小写不敏感、空白覆盖视为未配置、
  未配置即空（= 系统默认）；偏好经 app.db 往返；越界路径被拒。
- **迁移已在真实 app.db 上生效**：`~/Library/Application Support/dev.zicowarn.hivetask/app.db` 的
  `user_version = 7`，`prefs` 表存在且 schema 与 `app_007_prefs.sql` 一致（`sqlite3 .schema prefs` 核对）。
- `pnpm gate` 全绿；`src/knowledge/**` 与设置面板无裸像素字号。

### 13.5 未完成 / 待你验

1. **点击级的实机验证没做完**：本轮尝试启动应用做端到端点击时，`screencapture` 返回
   `could not create image from display`（屏幕不可用/已锁），GUI 侧无法取证。需要你验的两点：
   ① 设置里填/选一个应用 → 预览头「用默认程序打开」用它打开；留空 → 系统默认程序；② 失败时预览区会显示错误文本（便于定位）。
2. **按扩展名覆盖**：数据模型（`OpenWithPrefs.byExt`）与 Rust 解析逻辑均已支持并有单测，
   **但设置面板目前只暴露"默认应用"一项**（未摆空控件）。需要 UI 的话是下一步的小增量。

## 14. 附：本轮发现的另一处存量问题（不在本轮范围，仅报备）

`src/api.ts` 定义了 `sourceConfigGet` / `sourceConfigSet`（Gitea 实例地址的读写），
但 **Rust 侧没有这两个命令**（`src-tauri/src/` 全库搜不到 `source_config`；命令注册表里也没有）。
`settings` store 的加载包在 try/catch 里，所以表现为**静默失效**：Gitea 地址读不到也存不上。
不属于知识库范围，我没有动；要修的话是 `gitea` 那条线的一个小任务（补命令或改走 app.db 的 prefs 表）。

## 15. 已知问题 / 待办（更新）

1. **T0 spike 未做**（CM6 live-preview + Mermaid + KaTeX + 中文 IME）——主路线 B 的验证前提，下一轮第一件事。
2. Markdown 预览当前复用 `MarkdownView`（markdown-it）；S2 起改用编辑器自身渲染。
3. 页签**不持久化**（重启后回到空）；VS Code 会恢复上次打开的文件，列入 T10。
4. 文件树无键盘导航 / 右键菜单 / 拖拽 / 多选（T9/T10）；预览无 PDF/Office 等（T8）。
5. 大目录（≥10 万文件）懒加载性能未实测（计划 §7 风险 3）。

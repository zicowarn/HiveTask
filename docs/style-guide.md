# HiveTask 风格规范

> 样式统一的依据文件。新增/修改 UI 时先读这里；发现与本规范不符的存量样式，
> 顺手收敛或在「待统一」一节登记。各节给出示范代码所在的源文件，照抄即可。

## 1. 图标

**规则：UI 功能图标一律用内联 SVG，不用 Unicode 字符（⚙ ☰ ✕ 类）。**

- 原因：字符在文本字体中渲染偏小偏细（⚙ 与 ☀/☾ 并排即失衡）、跨平台字形
  不一致、还可能被渲染成彩色 emoji（U+2699 + VS16）。
- 尺寸：viewBox 16，显示 **14px**（与 12px 文字按钮视觉平衡）。
- 颜色：`fill="currentColor"`，自动继承按钮文字色与 hover 强调色，永不给图标写死颜色。
- 无障碍：装饰性图标加 `aria-hidden="true"`，语义由按钮的 `title` / 文本承担。
- 容器：按钮设 `display: inline-flex; align-items: center`，消除 svg 基线空隙。
- 来源约定：优先取 **Octicons（MIT）**，与本项目 GitHub 风格的取色语言一致。

示范：`src/App.vue` 的设置按钮（gear-btn，Octicons gear-16）。

```html
<button class="header-btn gear-btn" :title="t('menu.preferences')" @click="...">
  <svg class="gear-icon" viewBox="0 0 16 16" width="14" height="14"
       fill="currentColor" aria-hidden="true"><path d="…"/></svg>
</button>
```

```css
.gear-btn { display: inline-flex; align-items: center; padding: 4px 9px; }
.gear-icon { display: block; }
```

**例外——CSS background-image 中的 SVG（如下拉 chevron）**：data URI 读不到
CSS 变量，因此在 `[data-theme="light"]` 下覆盖 `background-image` 换一份
亮色（对应亮主题的 `--text-dim`）。见 `PanelShell.vue` 与
`SettingsBasicMode.vue`；新增带 chevron 的控件照抄此模式，并记得两份都画。

**已登记图标清单**：gear-16（App.vue 设置按钮）。

## 2. 颜色 token

**规则：组件内禁止硬编码色值，一切走 `src/styles.css` 的 CSS 变量。**
（唯一豁免：§1 的 data URI，且必须暗/亮各一份。）

| 分组 | token |
|---|---|
| 表面 | `--bg-app` `--bg-panel` `--bg-hover` `--bg-selected` `--bg-chip` |
| 文本 | `--text` `--text-dim` |
| 强调 | `--accent` `--accent-soft` |
| 状态 | `--success` `--warning` `--merged` `--danger` |
| 状态底色 | `--success-soft` `--warning-soft` `--merged-soft` `--danger-soft` |
| 横幅 | `--danger-banner` `--danger-banner-border` |
| 滚动条 | `--scrollbar-thumb` `--scrollbar-thumb-hover` |

- 主题机制：`:root` 为暗色基准（兼做 JS 未执行时的兜底），`[data-theme="light"]`
  整块覆盖，`color-scheme` 同步切换。数据由 `src/theme.ts` 挂在 `<html>`。
- 取色语言：GitHub Primer（暗/亮同源），状态色跨主题保持 GitHub 语义
  （open=success、merged=merged、review_required=warning、changes_requested=danger）。
- **状态徽章模式**：`color: var(--x); background: var(--x-soft);`，不描边。
  示范：`PullDetailPanel.vue` 的 `.detail-state/.detail-decision` 系列。
- **错误横幅模式**：文字 `--danger` + 底 `--danger-banner` + 边 `--danger-banner-border`。
  示范：`App.vue` 的 `.gh-warning`、两个列表面板的 `.error-banner`。

## 3. 控件与布局尺寸

- **面板 header 定高 44px**（`.panel-header`），不随内容撑高；内部控件统一
  **22px 高**：panel-type-select、refresh-btn、state-tab、ModeTabs
  （mode-tab 为 18px + 1px padding + 1px border = 22）。新增 header 控件照 22px 归一。
- 应用 header 44px（`.app-header`）；状态栏 24px（`.statusbar`）。
- **列表行分隔线**：行间 1px 发丝线，宽 80% 居中（左右各让 10%）。
  `border-top` 无法控宽，用伪元素：`.item-row + .item-row::before`，
  首行无线。间距对称：线上 8px（上行 padding-bottom）/ 线下 8px（flex gap 4px
  + ::before margin-bottom 4px）。示范：`IssueRow.vue`、`PullListPanel.vue`。
- **状态栏单元格**：全高、hover 反白高亮；可点击的用 `button.status-cell`
  （语言轮换、仓库切换），只读的用 `span`。示范：`StatusBar.vue`。

## 4. 待统一（技术债登记处）

- [ ] ☀/☾ 主题按钮仍是字符符号（字形尚饱满，暂可接受）→ 换 Octicons
      sun/moon-16，随主题切换图标。
- [ ] `IssueRow.vue` 与 `PullListPanel.vue` 的 `.item-row` 及分隔线样式完全
      重复 → 抽公共样式（全局 class 或共享 CSS 文件）。
- [ ] `SettingsBasicMode.vue` 与 `PanelShell.vue` 的 chevron data URI 重复
      （且是色值硬编码的唯一豁免点）→ 抽公共 select 样式或封装组件。
- [ ] 列表面板的 `.state-tab`/`.refresh-btn` 在两个列表面板中重复 → 同上。
- [ ] 新增图标后在此清单登记（名称 + 使用位置 + 来源）。

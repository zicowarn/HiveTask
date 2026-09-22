# E2E 冒烟手册——已知可靠配方与禁用清单

> 目的：终结"每次验证现场发明工具"的试错循环。本文件只收录**在本项目实测可靠**的
> 手段；新手段必须实测连续成功 3 次后才可收录。
> 纯逻辑验证不走本手册——先跑门禁（分层见 AGENTS.md「质量门禁」：小步用
> `pnpm gate:fast`，提交前 `pnpm gate` 全量六步）。

## 背景：dev 与生产的端口模型

- **dev**：页面来自 vite（:1420），端口是"页面地址"的一部分——tauri 二进制
  编译期记住 devUrl，vite 换口而二进制不知就会白屏/错配。因此 strictPort
  必须保留；两个 Tauri 项目并行开发 = 各自改对（vite port + tauri.conf
  devUrl 成对改）。
- **生产**（tauri build）：页面打进二进制（内部资源协议），**不占任何
  TCP 端口**——多应用安装/运行零冲突。唯一要求：bundle identifier
  全局唯一（本项目 dev.zicowarn.hivetask 已配置）。

## 标准流程

1. **改代码后先整页验证**：HMR 长会话会积累幽灵状态（模块实例重复、监听器错乱）。
   诊断任何"灵异现象"前，先整页重载（touch 一个入口文件触发 full-reload）。
2. `pnpm tauri dev`（用户终端）或 `open src-tauri/target/debug/hivetask`（需 vite 在 :1420）。
3. 按下方"AX 断言清单"逐项检查。

## ✅ 可靠配方（实测连续成功）

| 手段 | 用法 | 备注 |
|---|---|---|
| System Events 菜单点击 | `click menu item "工具" of menu 1 of menu bar item "视图" ...` | 原生菜单 100% 可靠 |
| AX 全量读 | `get entire contents of window 1` → 按 static text 内容断言 | 看面板渲染状态首选 |
| AX 按钮点击 | 行元素加 `role="button"` 后 `click (first button ... whose name contains "...")` | 可交互元素补语义是正路 |
| 窗口截图 | `screencapture -x -o -R<x,y,w,h> /tmp/x.png` + PIL 裁剪 | 通道健康时可靠 |
| localStorage 直写 | 关应用后改 `~/Library/WebKit/hivetask/.../localstorage.sqlite3`，**值必须 UTF-16LE** | 绕开原生对话框的唯一路 |
| 前置应用 | `set frontmost to true` | 激活失败时重试一次 |

## 🚫 禁用清单（实测翻车，勿再尝试）

- **助手长期占用 :1420**：dev server 归属用户终端（`pnpm tauri dev` 是一体的）。
  助手后台起的 vite 会与用户的工作流抢端口（双方连环失败）。需要应用运行时
  请求用户启动，或临时起用后**用完即还**（`lsof -ti :1420 | xargs kill`）；

- **CUA 坐标点击**：被通知横幅的全屏透明覆盖层劫持，所有坐标解析到 NotificationCenter；
- **AX 点击带嵌套危险按钮的行元素**（如仓库管理行内嵌 ✕ 删除登记）：2026-09-18 实测
  整表枚举匹配行元素却命中删除按钮，**误删了 tauri-real 登记**（当日已从 app.db 主库
  空闲页残迹取回全行并原样重建）。纪律：行点击前必须核对 `help`（危险子按钮带
  title→help，行元素为空）以资区分；含破坏性子按钮的列表优先请用户人工点选；
- **原生对话框合成按键**（打开文件夹面板 + ⌘⇧G）：静默失败。绕法：直改 localStorage；
- **浏览器预览验证 Tauri-only 功能**（gh/PTY/git2 调用全部 isTauri 门控）；
- **HMR 长会话里的任何结论**——先重载再说；
- `cat > file` 覆盖写：用 Write 工具或先 commit。

## 诊断纪律

- 同一验证通道**连续失败 2 次**：换下一层（单测 → AX → 截图 → 人工），不要硬试第三次；
- AX "0 windows" / screencapture "could not create image" 先怀疑**探测通道**（屏幕锁定、
  会话显示中断），用 `lsof -i :1420` 看 webview 的 ESTABLISHED 连接作为窗口存活的旁证；
- 断言优先读文本内容（static text value），不依赖坐标与像素。

## 断言清单（工具工作区示例）

1. header 仓库路径 = 预期 repo（static text 3）
2. 工作区 Tab 数量与文案
3. Git 面板列头 = 图/日期/作者/提交（i18n）
4. 分支条折叠态 = 「分支 + 当前分支 + 还有 N 个分支」
5. 提交行存在（button name 含提交信息）
6. 状态栏单元格：⟳ 相对时间 / ● 在线 / ● gh / 语言 / 版本

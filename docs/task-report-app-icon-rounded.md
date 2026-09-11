# 任务报告：应用图标 macOS 圆角（含"改了不生效"根因）

- 日期：2026-09-11
- 分支：`feat/pr-module`（本地开发分支，不推送远端）
- 交付提交：`b90e08a`（圆角图标资源）、本报告同批（`build.rs` 图标依赖登记）

## 1. 问题

Dock / 任务栏中应用图标显示为**方形**，没有圆角。

根因分两层：

1. **macOS 不像 iOS 会自动裁切圆角**。iOS 的 Springboard 会对图标蒙版圆角；
   macOS 的 Dock 完全按图片绘制，圆角必须烘焙进 `icon.icns` 本身。项目用的
   Tauri 默认图标是四角 `alpha=255` 的铺满方图，因此显示为方块。
2. **图标资源改了但不生效**（第一次修复失败的原因，见第 3 节）。

## 2. 圆角资源生成

- 新增 `src-tauri/scripts/make-rounded-icon.swift`：把原方形图标缩进**居中的圆角
  瓦片**，瓦片外留透明边距。
  - **瓦片占比 `tile=0.82`**：Apple 的 macOS 图标网格是 1024 画布上约 824×824
    的瓦片（≈80.5%），其余为透明边距。首版做成满画布（100%）会明显比系统应用
    偏大，故默认缩到 82%（实测不透明包围盒 840/1024＝82.03%，四周各留 92px）。
  - **圆角比例 `radiusFraction=0.2235` 相对瓦片边长**（而非画布），这样加边距
    不会改变角部观感（1024 下半径 187，对应 Apple 的 185.4/824）。
  - 用 `NSBitmapImageRep` 显式位图渲染，而非 `lockFocus()`——后者会继承屏幕
    backing scale，在 Retina 上输出 2048 图、换机器结果漂移。
  - 源图本身已有不透明 `#1e1f22` 底，故只做"圆角裁剪 + 绘制"，瓦片外与圆角
    缺口均为真透明。
- 以生成图为输入跑 `pnpm tauri icon`，重新导出桌面图标；随后**还原
  iOS/Android/Windows 磁贴生成物**——桌面项目不打包它们，且 iOS 要求图标
  不得带 alpha（自动圆角会被系统拒绝），保留会埋雷。

验证（逐张读像素）：`32/64/128/256/512 PNG` 与 `icon.icns` 内全部 10 张
representation，四角 `alpha=0`、中心 `alpha=255`。

## 3. 关键根因：图标没被编译进二进制

第一次只换了图标资源，Dock 依旧方块。排查结论：

- macOS **dev** 模式下，`tauri-codegen` 会把 `icons/icon.icns` 的**原始字节嵌入
  二进制**（`CachedIcon::new_raw(...).to_vec()`，`context.rs:246`），运行时由
  `setApplicationIconImage` 设为 Dock 图标（`tauri-2.11.5/src/app.rs:2578`）。
  即图标是**编译期产物**，不是运行时读文件。
- 而 `tauri-build` 只对 `src/`、`resources`、`capabilities`、tauri 配置登记
  `rerun-if-changed`，**没有登记图标文件**。于是"只改图标"不构成任何被追踪的
  输入变化，cargo 判定无需重编译，二进制里仍是旧的方形 icns。

证据（对旧二进制做字节搜索）：

```
OLD square icns embedded : True
NEW rounded icns embedded: False
```

修复：`src-tauri/build.rs` 中显式声明图标依赖：

```rust
println!("cargo:rerun-if-changed=icons");
// 并对 icon.icns / icon.ico / icon.png / 32 / 128 / 128@2x 逐个声明
```

## 4. 修复后验证

- 重编译后二进制字节搜索：`OLD=False`、`NEW=True`，圆角图标已真正嵌入。
- 持久性验证：仅 `touch icons/icon.icns` 后 `cargo build` 输出
  `Compiling hivetask`（此前只会直接 `Finished`）——图标变更已能触发重编译。

## 5. 备注

- 若 Dock 仍显示旧图标，属系统图标缓存：`killall Dock Finder` 后重开。
- 调尺寸/圆角：脚本参数依次为 `<输入> <输出> [画布] [瓦片占比] [圆角比例]`
  ```bash
  cd src-tauri && swift scripts/make-rounded-icon.swift \
      icons/icon.png icons/icon-rounded-1024.png 1024 0.82 0.2235
  ```
  瓦片占比越小图标越小（macOS 网格约 0.805～0.83）；圆角比例越大越圆
  （`0.2235`≈Big Sur，想更圆可到 `0.25`）。
- 脚本用的是圆角矩形路径（`NSBezierPath` 无 squircle API），比例已调到与
  Big Sur 视觉一致；如需数学意义上的连续曲率超椭圆需另写路径算法。

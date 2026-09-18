# 数据落盘布局（设计定案）

> 2026-09-18。背景：审查「两个数据库」时确认历史布局把每仓库索引
> `hivetask.db` 写进了用户仓库工作区（`<repo>/.hivetask/`），属于对代码
> 仓库的入侵（要靠 `.git/info/exclude` 打补丁、worktree 兜不住、clone
> 之间不互通）。本次重构把索引迁出，确立下面的最终布局。

## 最终布局

| 数据 | 位置 | 性质 / 真源 |
|---|---|---|
| 登记层（connections / repos 指针 / projects / prefs） | `<app data>/app.db`（全局唯一） | 本机私有，跟应用走 |
| 每仓库索引缓存（issues/pulls/comments 物化视图） | `<app data>/repo-index/<目录名>-<路径指纹>/hivetask.db` | **可重建**：远端缓存重拉取；本地 Issue 重放 journal |
| 本地 Issue 事件日志（**真源**） | 仓库 `.git` 内的隐藏引用 `refs/hivetask/issues`（事件 commit 链） | 随 `.git` 目录走但 **clone 不带**（隐藏引用需显式 refspec / `git bundle --all`，冷启动补拉见《本地Issue与本地分支Review》Q2）；未来 push/fetch 这条引用即共享；不进工作区、无需 gitignore |
| 仅远端登记的合成仓库目录 | `<app data>/repos-cache/<owner>/<repo>/` | 仓库根替身（journal 引用住它的 `.git`；索引同样在 repo-index/） |
| 知识库 | 用户自选根目录 | 纯用户文件，应用不落任何私有数据 |

app data 目录：macOS `~/Library/Application Support/dev.zicowarn.hivetask/`；
Windows `%APPDATA%\dev.zicowarn.hivetask`；Linux `~/.local/share/dev.zicowarn.hivetask`。

索引目录名 = `<仓库目录名>-<FNV-1a(规范路径) 16hex>`：目录名给人看，指纹保证
同名不同路径不撞、可反查归属。

## 设计原则

1. **真源与索引分离**：真源要么在 git 里（事件日志引用），要么在平台侧
   （GitHub Issue）；SQLite 索引永远只是物化视图，删了能重建 → 它不需要
   随仓库走，也不需要同步。
2. **应用地盘原则（红线）**：应用不向用户仓库工作区写入任何文件；
   不碰 `.git/info/exclude`。跟仓库走的数据一律进 git 对象/引用
   （journal 的 git2 写路径只动 tree/blob/ref，不碰 index 与工作区）。
3. **两级数据库职责**：app.db = 跨仓库登记（指针与连接，删除只删指针）；
   repo-index/ 的 hivetask.db = 每仓库一份业务缓存。

## 迁移行为（storage.rs `migrate_legacy_index`）

首次 `storage::open(repo_root)` 时自动执行，幂等：

1. 新索引目录已有库 → 跳过；
2. 找历史遗留：`<repo>/.hivetask/hivetask.db` 与嵌套 bug 产物
   `<repo>/.hivetask/.hivetask/hivetask.db`（历史上 lib.rs 与 local.rs 对
   `storage::open` 传了两种目录约定所致），并存时取 mtime 较新者；
3. `rename` 移入索引目录（跨文件系统失败则复制+删除）；失败不阻塞——
   索引可重建，数据自愈；
4. 删掉空掉的 `.hivetask/` 层（`remove_dir` 只删空目录，绝不动用户文件）；
5. 撤销当年追加进 `.git/info/exclude` 的 `.hivetask/` 行（其余行原样保留）。

## 共享设计（未实现，路径已铺好）

- 共享 = `git push/fetch origin refs/hivetask/issues`（shell git，复用用户
  凭据 helpers——与 `git.rs::fetch` 同模式）；「共享开关」开关的就是这一条命令。
- ⚠️ `git clone` 与 `git fetch --all` **默认都不带** `refs/hivetask/*`（隐藏
  引用按 remote.refspec 走）——现有 `git.rs::fetch` 同样同步不到它；共享与
  迁移必须显式 refspec，单文件交接用 `git bundle --all`。
- 双机并发追加导致引用分叉：事件自带 `ts`、编号随事件持久化、重放幂等
  （journal.rs），合并两条链后全量重放即收敛；实现时要设计 ref 层合并
  （fast-forward 不了时造合并提交把两条链都挂住）。
- 两台机器各自拉取远端 Issue 缓存 → 各自的 repo-index，天然无冲突。

## 历史版本对照

| 版本 | 索引位置 | 问题 |
|---|---|---|
| ≤ 2026-09（旧） | `<repo>/.hivetask/hivetask.db` + `.git/info/exclude` 补丁 | 入侵用户仓库；worktree 兜不住；两套调用约定产生嵌套 `.hivetask/.hivetask/` |
| 2026-09 起（现） | `<app data>/repo-index/<key>/hivetask.db` | 仓库零污染；exclude 行随迁移撤销 |

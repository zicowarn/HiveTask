/**
 * 撤销/重做：脏矩形 patch 栈。
 *
 * 不存全画布快照——1920×1080 一步就是 ~8.3 MB，连画十几笔就吃掉几百 MB。
 * 每步只存改动矩形的 before/after 像素（Uint8ClampedArray 拷贝），
 * 并按**字节预算**淘汰最旧步骤：预算内小笔画可以存几百步，
 * 整幅大区域操作（如全图马赛克）则只留最近几步。
 */

export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
  /**
   * 裁剪/旋转这类**改画布尺寸**的操作：入口尺寸记在这，before = 旧尺寸的全图、
   * after = 新尺寸的全图（x/y 恒 0）。undo 先把画布恢复到 cropFrom 再贴 before；
   * redo 先把画布改成 (w, h) 再贴 after——普通 patch 不设此字段，语义不变。
   */
  cropFrom?: { w: number; h: number };
}

/** 撤销栈字节预算（before + after 合计；256 MB 足够常规标注流程）。 */
export const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

function patchBytes(patch: Patch): number {
  return patch.before.byteLength + patch.after.byteLength;
}

export class EditHistory {
  private undoStack: Patch[] = [];
  private redoStack: Patch[] = [];
  private bytes = 0;

  /** maxBytes 可注入（测试用小预算；生产用 MAX_HISTORY_BYTES）。 */
  constructor(private readonly maxBytes: number = MAX_HISTORY_BYTES) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 当前占用（测试与诊断用）。 */
  get usedBytes(): number {
    return this.bytes;
  }

  /** 提交一步：redo 失效（新笔画分叉），并按预算淘汰最旧步骤。 */
  push(patch: Patch): void {
    if (this.redoStack.length > 0) {
      this.redoStack = [];
    }
    this.undoStack.push(patch);
    this.bytes += patchBytes(patch);
    // 至少保留最后一步：哪怕它一人超标（全图操作），也允许撤销一次
    while (this.bytes > this.maxBytes && this.undoStack.length > 1) {
      const dropped = this.undoStack.shift();
      if (dropped) this.bytes -= patchBytes(dropped);
    }
  }

  /** 撤销：返回要回写的 patch（调用方 putImageData(before)），并转入重做栈。 */
  undo(): Patch | null {
    const patch = this.undoStack.pop();
    if (!patch) return null;
    this.bytes -= patchBytes(patch);
    this.redoStack.push(patch);
    return patch;
  }

  /** 重做：返回要回写的 patch（调用方 putImageData(after)），并退回撤销栈。 */
  redo(): Patch | null {
    const patch = this.redoStack.pop();
    if (!patch) return null;
    this.bytes += patchBytes(patch);
    this.undoStack.push(patch);
    return patch;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }
}

/**
 * 「光标在表格里」与「网格编辑对话框」之间的桥 —— 逐文件对照移植自 SoloMD
 * `app/src/lib/table-editor-bus.ts`（MIT, © 2026 xiangdong li）。
 *
 * 编辑器按面板存在，对话框全窗口只有一个：找到表格的面板把自己的 `apply`
 * 闭包交给总线，对话框不需要知道对面是哪个编辑器。
 */
import { reactive } from "vue";

export interface TableEditSession {
  /** 表格的 Markdown 源码（与文档中逐字一致）。 */
  source: string;
  /** 把编辑后的表格写回原范围。 */
  apply: (markdown: string) => void;
}

export const tableEditor = reactive<{ session: TableEditSession | null }>({
  session: null,
});

export function openTableEditor(session: TableEditSession): void {
  tableEditor.session = session;
}

export function closeTableEditor(): void {
  tableEditor.session = null;
}

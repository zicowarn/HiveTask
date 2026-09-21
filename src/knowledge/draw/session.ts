/**
 * 绘图会话状态：工具条与画布共享的**唯一状态源**。
 *
 * 由宿主（KnowledgePreview）创建一次、作为 prop 下发给工具栏与画布——
 * 工具栏直接改字段、画布回写 canUndo/dirty，不需要事件总线。
 * 纯数据（预设表）在这里，交互状态机在画布组件里。
 */
import { reactive } from "vue";
import type { MessageKey } from "../../i18n";

export type DrawTool = "pencil" | "eraser" | "fill" | "line" | "arrow" | "rect" | "ellipse" | "mosaic" | "text" | "crop";

export interface DrawToolDef {
  key: DrawTool;
  icon: string;
  labelKey: MessageKey;
}

/**
 * 工具表（顺序 = 工具条顺序）。
 * 图标口径：Octicon 有的用 `o.*`（pencil / arrow-right / square / circle / typography，
 * 路径取自 @primer/octicons@19.11.0）；平台没有对应物的（橡皮/直线/撤销/重做/马赛克）
 * 走自绘族 `draw.*`（见 EditorIcon.vue，14 viewBox stroke，规范允许）。
 */
export const DRAW_TOOLS: DrawToolDef[] = [
  { key: "pencil", icon: "o.pencil", labelKey: "kb.drawPen" },
  { key: "eraser", icon: "draw.eraser", labelKey: "kb.drawEraser" },
  { key: "fill", icon: "draw.fill", labelKey: "kb.drawFill" },
  { key: "line", icon: "draw.line", labelKey: "kb.drawLine" },
  { key: "arrow", icon: "o.arrow-right", labelKey: "kb.drawArrow" },
  { key: "rect", icon: "o.square", labelKey: "kb.drawRect" },
  { key: "ellipse", icon: "o.circle", labelKey: "kb.drawEllipse" },
  { key: "mosaic", icon: "draw.mosaic", labelKey: "kb.drawMosaic" },
  { key: "text", icon: "o.typography", labelKey: "kb.drawText" },
  { key: "crop", icon: "draw.crop", labelKey: "kb.drawCrop" },
];

/** 预设色：标注常用高饱和色（画在截图上要醒目），自定义色走原生取色器兜底。 */
export const COLOR_PRESETS = ["#e5534b", "#f0883e", "#d4a72c", "#57ab5a", "#76e3ea", "#539bf5", "#b083f0", "#f0f6fc"];

/** 笔宽档位（画布像素）。 */
export const WIDTH_CHOICES = [2, 4, 6, 8, 12];

/** 字号档位（画布像素）。 */
export const FONT_CHOICES = [12, 16, 24, 32, 48];

export interface DrawSessionState {
  tool: DrawTool;
  color: string;
  width: number;
  fontSize: number;
  canUndo: boolean;
  canRedo: boolean;
  /** 本次编辑产生过笔画（撤销到空 = 不脏）。 */
  dirty: boolean;
}

/** 默认红色（标注的主色）、笔宽 4、字号 24（截图上可读的下限附近）。 */
export function createDrawSession(): DrawSessionState {
  return reactive({
    tool: "pencil" as DrawTool,
    color: "#e5534b",
    width: 4,
    fontSize: 24,
    canUndo: false,
    canRedo: false,
    dirty: false,
  });
}

/** 回到初始态（对同一文件重新进入编辑时复用同一个 session 对象）。 */
export function resetDrawSession(session: DrawSessionState): void {
  session.tool = "pencil";
  session.color = "#e5534b";
  session.width = 4;
  session.fontSize = 24;
  session.canUndo = false;
  session.canRedo = false;
  session.dirty = false;
}

/** 新建空白画布的默认尺寸（16:9，够随手画示意图；需要别的尺寸裁剪即可）。 */
export const BLANK_CANVAS_SIZE = { width: 1280, height: 720 };

/**
 * 模块级会话单例：工具条 / 画布 / 预览宿主直接共享（不作为 prop 传递——
 * 工具条要就地改工具/颜色，做成 prop 会撞 vue/no-mutating-props）。
 * 前提：知识库是单面板工作区，同屏最多存在一个绘图会话。
 */
export const drawSession = createDrawSession();

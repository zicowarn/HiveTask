/**
 * 项目视图配置——板面的一整套显示配置（筛选 / 排序 / 排序方向 / 分列字段 /
 * 显示字段），按项目持久化。
 *
 * 纯数据 + 默认值：面板与 store 共用一份定义，测试不必拉起 Pinia。
 * 命名视图（可保存、可切换的档位）尚未落地——真要做的第一步是字段自建与
 * 字段类型，见 TASK 后置项。
 */
import type { MessageKey } from "../i18n";

export type ProjectSortBy = "manual" | "priority" | "added";

/**
 * 可显示字段目录（顺序即卡片/表格列的出现顺序）。
 * 三层来源：条目自身 → 引用实体镜像（Issues/PR 元数据） → 项目字段。
 */
export const viewFieldIds = [
  "title",
  "kind",
  "source",
  "added",
  "state",
  "author",
  "assignees",
  "labels",
  "milestone",
  "created",
  "updated",
  "status",
  "priority",
] as const;
export type ViewFieldId = (typeof viewFieldIds)[number];

/** 引用实体镜像字段（草稿卡没有；来自仓库缓存里的 Issue/PR 元数据）。 */
export const entityFieldIds: ViewFieldId[] = [
  "state",
  "author",
  "assignees",
  "labels",
  "milestone",
  "created",
  "updated",
];

/** 项目字段（project_fields 表里的两类）。 */
export const projectFieldIds: ViewFieldId[] = ["status", "priority"];

/** 配置版本：字段目录扩容时用它把「用户没关过、只是当时还不存在」的字段补回来。 */
export const VIEW_CONFIG_VERSION = 3;

export interface ProjectViewConfig {
  /** 配置版本（缺省 = 首版，加载时按新目录合并字段）。 */
  version: number;
  /** 筛选表达式（与筛选框同一套 token 语法）。 */
  filter: string;
  sortBy: ProjectSortBy;
  /** 排序方向：true = 降序（manual 无方向）。 */
  sortDesc: boolean;
  /** 分列字段 id；null = 内置状态字段（默认）。 */
  columnFieldId: string | null;
  /** 泳道字段 id（Board 的第二分组维度）；null = 不分泳道。 */
  swimlaneFieldId: string | null;
  /** 列头合计：计数（"count"，平台渲染为列头 CounterLabel 胶囊）与数字字段（按字段 id）。 */
  sumFieldIds: string[];
  /** 数字字段求和是否已按目录播种过一次（用户关掉后不再回填；与 version 无关）。 */
  sumsSeeded?: boolean;
  /** 已见过的字段 id（项目字段）：新出现的字段默认入显示列表，用户关掉的不会回填。 */
  knownFieldIds?: string[];
  /** 从视图中隐藏的列 / 泳道段（选项 id；只影响呈现，不动物据）。 */
  hiddenColumns: string[];
  hiddenLanes: string[];
  /** 列上限（选项 id → 上限；缺省 = 无上限）。 */
  columnLimits: Record<string, number>;
  /** 折叠的泳道段（选项 id）。 */
  collapsedLanes: string[];
  /** Roadmap：结束日期字段 id（配合开始日期字段画区间条；null = 单点）。 */
  dateEndFieldId: string | null;
  /** 逐字段排序（平台的 Sort ascending/descending）；null = 用上面的通用排序。 */
  fieldSort: { fieldId: string; desc: boolean } | null;
  /** Team items 切片（平台 Slicer）：字段键（viewKey 语义，见 store）+
   *  选中值；字段 null = 不切片（左导航整个收起）。 */
  sliceFieldId: string | null;
  sliceValue: string | null;
  /** 切片值面板：零条目值是否显示（平台 Show/Hide empty values）。 */
  sliceShowEmpty: boolean;
  /** 显示字段（board 渲染在卡片上，table 决定列）。 */
  fields: ViewFieldId[];
}

export function defaultViewConfig(): ProjectViewConfig {
  return {
    version: VIEW_CONFIG_VERSION,
    filter: "",
    sortBy: "manual",
    sortDesc: false,
    columnFieldId: null,
    swimlaneFieldId: null,
    sumFieldIds: ["count"],
    sumsSeeded: false,
    knownFieldIds: [],
    hiddenColumns: [],
    hiddenLanes: [],
    columnLimits: {},
    collapsedLanes: [],
    dateEndFieldId: null,
    fieldSort: null,
    sliceFieldId: null,
    sliceValue: null,
    sliceShowEmpty: false,
    fields: [...viewFieldIds],
  };
}

/** 字段名的 i18n key（字段面板、表头共用；新增字段只改这一处）。 */
export const fieldLabelKeys: Record<ViewFieldId, MessageKey> = {
  title: "project.colTitle",
  kind: "project.colKind",
  source: "project.colSource",
  added: "project.colAdded",
  state: "project.colState",
  author: "project.colAuthor",
  assignees: "project.colAssignees",
  labels: "project.colLabels",
  milestone: "project.colMilestone",
  created: "project.colCreated",
  updated: "project.colUpdated",
  status: "project.colStatus",
  priority: "project.colPriority",
};

/** 布局档位（对齐平台 View 弹层顶部的 Layout 分段）。 */
export type ProjectLayout = "table" | "board" | "roadmap";

/** 一个视图 = 名字 + 布局 + 一套板面配置（对齐平台的 view 概念）。 */
export interface ProjectViewEntry {
  id: string;
  name: string;
  layout: ProjectLayout;
  config: ProjectViewConfig;
}

/** Table 布局的平台默认列集（取证 views/1?layout=table：Title + Assignees +
 * Status + Priority；其余字段经列头「选择列/隐藏」或视图设置添加）。 */
export const TABLE_DEFAULT_FIELDS = ["title", "assignees", "status", "priority"] as const;

/** 种子视图：Backlog（现有看板，保持不变）+ Table + Priority board +
 *  Team items（切片视图：左导航按 Assignees 切、主区按 Status 分组，平台
 *  Team items 实测形态）+ Roadmap。 */
export function defaultViewEntries(): ProjectViewEntry[] {
  const base = defaultViewConfig;
  return [
    { id: "backlog", name: "Backlog", layout: "board", config: base() },
    {
      id: "table",
      name: "Table",
      layout: "table",
      config: { ...base(), fields: [...TABLE_DEFAULT_FIELDS] as ProjectViewConfig["fields"] },
    },
    {
      id: "priority",
      name: "Priority board",
      layout: "board",
      config: { ...base(), swimlaneFieldId: "priority", sortBy: "priority" },
    },
    {
      id: "team",
      name: "Team items",
      layout: "table",
      config: {
        ...base(),
        swimlaneFieldId: "status",
        fields: [...TABLE_DEFAULT_FIELDS] as ProjectViewConfig["fields"],
        sliceFieldId: "assignees",
        sliceValue: null,
      },
    },
    { id: "roadmap", name: "Roadmap", layout: "roadmap", config: base() },
  ];
}

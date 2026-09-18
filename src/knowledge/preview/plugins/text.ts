/**
 * 文本 / 代码预览：**Prism 按语言高亮**（语言懒加载，与 OFV 的 text 插件同思路）。
 *
 * HiveTask 注：编码已由 Rust 侧探测并解码（`kb_read_text`），这里只管渲染；
 * 换行风格也在读取时归一，预览不做二次处理。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";

/** 扩展名 → Prism 语言组件名（与 prismjs/components/* 同名）。 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json5",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  properties: "properties",
  env: "properties",
  editorconfig: "editorconfig",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  fish: "bash",
  ps1: "powershell",
  bat: "batch",
  cmd: "batch",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  pl: "perl",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
  elm: "elm",
  fs: "fsharp",
  groovy: "groovy",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  dockerfile: "docker",
  dockerignore: "ignore",
  gitignore: "ignore",
  npmignore: "ignore",
  makefile: "makefile",
  mk: "makefile",
  nginx: "nginx",
  proto: "protobuf",
  hcl: "hcl",
  tf: "hcl",
  tex: "latex",
  dot: "dot",
  gv: "dot",
  http: "http",
  log: "log",
  txt: "none",
  md: "markdown",
  // Shapefile 的**文本**配套（点开 .shp 时同目录还有这些；用户也可能直接点到它们）：
  // .prj = 坐标系 WKT、.cpg = 属性表代码页名（如 "936"）
  prj: "none",
  cpg: "none",
  qpj: "none",
  // 其它常见的纯文本后缀（全样本审计里"无插件认领"的还有这些）
  csvt: "none",
  vrt: "none",
  wkt: "none",
  ndjson: "json",
  jsonl: "json",
  gitattributes: "ignore",
  gitmodules: "ignore",
};

/** 无扩展名但能按文件名认出来的（Dockerfile / Makefile / .gitignore 这类）。 */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".editorconfig": "editorconfig",
  license: "none",
};

export function languageFor(file: { name: string; ext: string }): string {
  const lower = file.name.toLowerCase();
  if (LANGUAGE_BY_NAME[lower]) return LANGUAGE_BY_NAME[lower];
  return LANGUAGE_BY_EXT[file.ext] ?? "none";
}

/** 懒加载 Prism 语言组件（核心包 + 按需语言；都在本地，无 CDN）。 */
async function loadPrism(language: string): Promise<typeof import("prismjs") | null> {
  if (language === "none") return null;
  const prism = (await import("prismjs")).default;
  // 语言组件按依赖顺序加载（markup-templating 是 php 等的前置）
  const loaders: Record<string, () => Promise<unknown>> = {
    markup: () => import("prismjs/components/prism-markup"),
    css: () => import("prismjs/components/prism-css"),
    clike: () => import("prismjs/components/prism-clike"),
    javascript: () => import("prismjs/components/prism-javascript"),
    typescript: () => import("prismjs/components/prism-typescript"),
    jsx: () => import("prismjs/components/prism-jsx"),
    tsx: () => import("prismjs/components/prism-tsx"),
    json: () => import("prismjs/components/prism-json"),
    json5: () => import("prismjs/components/prism-json5"),
    yaml: () => import("prismjs/components/prism-yaml"),
    toml: () => import("prismjs/components/prism-toml"),
    ini: () => import("prismjs/components/prism-ini"),
    properties: () => import("prismjs/components/prism-properties"),
    editorconfig: () => import("prismjs/components/prism-editorconfig"),
    bash: () => import("prismjs/components/prism-bash"),
    powershell: () => import("prismjs/components/prism-powershell"),
    batch: () => import("prismjs/components/prism-batch"),
    python: () => import("prismjs/components/prism-python"),
    ruby: () => import("prismjs/components/prism-ruby"),
    go: () => import("prismjs/components/prism-go"),
    rust: () => import("prismjs/components/prism-rust"),
    java: () => import("prismjs/components/prism-java"),
    kotlin: () => import("prismjs/components/prism-kotlin"),
    scala: () => import("prismjs/components/prism-scala"),
    c: () => import("prismjs/components/prism-c"),
    cpp: () => import("prismjs/components/prism-cpp"),
    csharp: () => import("prismjs/components/prism-csharp"),
    php: () => import("prismjs/components/prism-markup-templating").then(() => import("prismjs/components/prism-php")),
    swift: () => import("prismjs/components/prism-swift"),
    dart: () => import("prismjs/components/prism-dart"),
    lua: () => import("prismjs/components/prism-lua"),
    r: () => import("prismjs/components/prism-r"),
    perl: () => import("prismjs/components/prism-perl"),
    elixir: () => import("prismjs/components/prism-elixir"),
    erlang: () => import("prismjs/components/prism-erlang"),
    haskell: () => import("prismjs/components/prism-haskell"),
    clojure: () => import("prismjs/components/prism-clojure"),
    elm: () => import("prismjs/components/prism-elm"),
    fsharp: () => import("prismjs/components/prism-fsharp"),
    groovy: () => import("prismjs/components/prism-groovy"),
    sql: () => import("prismjs/components/prism-sql"),
    graphql: () => import("prismjs/components/prism-graphql"),
    scss: () => import("prismjs/components/prism-scss"),
    sass: () => import("prismjs/components/prism-sass"),
    less: () => import("prismjs/components/prism-less"),
    docker: () => import("prismjs/components/prism-docker"),
    ignore: () => import("prismjs/components/prism-ignore"),
    makefile: () => import("prismjs/components/prism-makefile"),
    nginx: () => import("prismjs/components/prism-nginx"),
    protobuf: () => import("prismjs/components/prism-protobuf"),
    hcl: () => import("prismjs/components/prism-hcl"),
    latex: () => import("prismjs/components/prism-latex"),
    dot: () => import("prismjs/components/prism-dot"),
    http: () => import("prismjs/components/prism-http"),
    log: () => import("prismjs/components/prism-log"),
    markdown: () => import("prismjs/components/prism-markdown"),
  };
  try {
    await loaders[language]?.();
    return prism;
  } catch {
    return prism; // 语言组件缺失不该让整篇预览失败：退回纯文本
  }
}

/** 文本类扩展名（其余交给别的插件；只读文本的类型都在这）。 */
export const TEXT_EXTENSIONS = Object.keys(LANGUAGE_BY_EXT);

export const textPlugin = {
  tools: ["find"] satisfies PreviewTool[],
  id: "text",
  extensions: TEXT_EXTENSIONS,
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const content = await ctx.readText();
    const language = languageFor({ name: ctx.name, ext: ctx.ext });
    const prism = await loadPrism(language);
    const pre = document.createElement("pre");
    pre.className = "kb-code";
    const code = document.createElement("code");
    code.className = `language-${language}`;
    if (prism && language !== "none" && prism.languages[language]) {
      code.innerHTML = prism.highlight(content, prism.languages[language], language);
    } else {
      code.textContent = content;
    }
    pre.appendChild(code);
    ctx.container.replaceChildren(pre);
    return withFind(ctx);
  },
};

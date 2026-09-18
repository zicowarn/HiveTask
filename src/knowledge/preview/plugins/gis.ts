/**
 * GIS 矢量预览（GeoJSON / TopoJSON / KML / KMZ / GPX / SHP）—— **离线优先**。
 *
 * 决策（照 plan §5.10）：
 * - **底图默认不加载**：OFV `gis.ts` 用 OSM 在线瓦片，离线场景下必然白屏；这里默认只画
 *   矢量要素并自动缩放到范围；需要底图时由用户**显式点击**「加载在线底图」——联网这件事
 *   必须是用户动作，不能藏在打开文件里；
 * - leaflet 的样式从本地 `leaflet/dist/leaflet.css` 引入（不走 CDN）；
 * - 点要素用 `circleMarker` 绘制，避开 leaflet 默认图标 PNG 的资源路径问题；
 * - SHP：`shpjs` 解析；同目录的 `.dbf`（属性）与 `.prj`（坐标系）通过 `readSibling` 一并读入，
 *   缺 `.prj` 时按 WGS84 处理并在信息行标注；
 * - 不做栅格（GeoTIFF/WMTS）、不做空间分析（那已超出"预览"）。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";

export const GIS_EXTENSIONS = ["geojson", "topojson", "kml", "kmz", "gpx", "shp"];

/** OSM 瓦片（仅在用户显式点击后请求）。 */
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/** 各格式 → GeoJSON（FeatureCollection）。 */
async function toGeoJson(
  ctx: PreviewContext,
  bytes: Uint8Array,
  text: () => Promise<string>,
): Promise<{ data: GeoJSON.FeatureCollection; note?: string }> {
  if (ctx.ext === "geojson") {
    const parsed = JSON.parse(await text()) as GeoJSON.GeoJSON;
    return { data: asCollection(parsed) };
  }
  if (ctx.ext === "topojson") {
    const { feature } = await import("topojson-client");
    const topo = JSON.parse(await text()) as never;
    const objects = Object.values((topo as { objects: Record<string, unknown> }).objects ?? {});
    const parts = objects.map((object) => feature(topo, object as never) as GeoJSON.GeoJSON);
    return { data: asCollection(parts.length === 1 ? parts[0] : { type: "FeatureCollection", features: parts.flatMap((p) => ("features" in p ? p.features : [p as GeoJSON.Feature])) }) };
  }
  if (ctx.ext === "kml" || ctx.ext === "kmz") {
    const { kml } = await import("@mapbox/togeojson");
    let xml = await text();
    if (ctx.ext === "kmz") {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(bytes);
      const name = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
      if (!name) throw new Error("KMZ 里没有 .kml 文件");
      xml = await zip.file(name)!.async("string");
    }
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return { data: kml(doc) as GeoJSON.FeatureCollection };
  }
  if (ctx.ext === "gpx") {
    const { gpx } = await import("@mapbox/togeojson");
    const doc = new DOMParser().parseFromString(await text(), "application/xml");
    return { data: gpx(doc) as GeoJSON.FeatureCollection };
  }
  // shp：主文件 + 同目录 .dbf（属性）/ .prj（坐标系）/ .cpg（属性表代码页，中文必备）
  //
  // ⚠️ `parseShp` / `parseDbf` / `combine` 是**命名导出**，不在默认导出上：
  // 默认导出只有 getShapefile。`@types/shpjs` 把它们声明在命名空间对象上，所以
  // TypeScript 会放行 `shpjs.parseShp(...)`，**运行时才炸**（实测 `.shp` 带 .dbf 时
  // `parseShp is not a function` —— 全样本审计抓到的）。这里按命名导入。
  const { default: shpjs, parseShp, parseDbf, combine } = await import("shpjs");
  const base = ctx.rel.replace(/\.shp$/i, "");
  const readSibling = ctx.readSibling;
  const sibling = async (suffix: string): Promise<Uint8Array | null> => {
    if (!readSibling) return null;
    try {
      return await readSibling(`${base}${suffix}`);
    } catch {
      return null;
    }
  };
  const dbfBytes = await sibling(".dbf");
  const prjBytes = await sibling(".prj");
  const cpgBytes = await sibling(".cpg");
  const prjText = prjBytes ? new TextDecoder().decode(prjBytes) : undefined;
  const cpgText = cpgBytes ? new TextDecoder().decode(cpgBytes).trim() : undefined;
  const toBuffer = (value: Uint8Array): ArrayBuffer =>
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const shpBuffer = toBuffer(bytes);
  if (dbfBytes) {
    const geometry = parseShp(shpBuffer, prjText);
    // 类型声明把 cpg 写成 buffer，实现里走 toString() 收字符串（代码页名如 "936"/"GBK"）
    const properties = parseDbf(toBuffer(dbfBytes), cpgText as unknown as Buffer);
    const pair: [GeoJSON.Geometry[], GeoJSON.GeoJsonProperties[]] = [geometry, properties];
    const combined = combine(pair);
    const notes = [!prjText ? "缺少 .prj，按 WGS84 处理" : "", cpgText ? `属性表按 ${cpgText} 解码` : ""].filter(Boolean);
    return { data: asCollection(combined), note: notes.join(" · ") || undefined };
  }
  const parsed = (await shpjs(shpBuffer)) as GeoJSON.FeatureCollection;
  return { data: asCollection(parsed), note: "同目录没有找到 .dbf，只有几何没有属性" };
}

function asCollection(input: GeoJSON.GeoJSON | GeoJSON.GeoJSON[]): GeoJSON.FeatureCollection {
  if (Array.isArray(input)) return { type: "FeatureCollection", features: input.flatMap((i) => asCollection(i).features) };
  if (input.type === "FeatureCollection") return input;
  if (input.type === "Feature") return { type: "FeatureCollection", features: [input] };
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: input }] };
}

async function renderGis(ctx: PreviewContext): Promise<PreviewInstance> {
  const bytes = await ctx.readBytes();
  // 不再画自己的信息条：那会和面板头部凑成"两行头部"（用户实测指出）。
  // 要素数等格式信息 → 状态栏（`ctx.onInfo`）；在线底图开关 → 头部工具（tools: ["basemap"]）。
  const { data, note } = await toGeoJson(ctx, bytes, ctx.readText);
  const featureCount = data.features.length;

  const wrap = document.createElement("div");
  wrap.className = "kb-gis";
  const mapEl = document.createElement("div");
  mapEl.className = "kb-gis-map";
  // 浮动信息角标：右上角，显示要素数与底图状态（与 attribution 同区域）
  const infoCorner = document.createElement("div");
  infoCorner.className = "kb-gis-info-corner";
  infoCorner.textContent = `${featureCount} 个要素 · 底图${note ? ` · ${note}` : ""}`;
  mapEl.appendChild(infoCorner);
  wrap.appendChild(mapEl);
  ctx.container.replaceChildren(wrap);

  await import("leaflet/dist/leaflet.css");
  const L = await import("leaflet");

  const map = L.map(mapEl, {
    // ⚠️ attributionControl 不能开：默认会创建一个**右下角**的 attribution，
    // 加上我们手动放的 topright 那个，"Leaflet" 就会出现在右下+右上两处（用户实测截图）。
    // 关掉默认的，只用下面显式创建的 topright 那一个。
    attributionControl: false,
    // Leaflet 自带的浮动 +/- 与"头部统一缩放"重复且风格不一致（用户实测指出）→ 关掉，
    // 改由面板头部的缩放控件驱动（见下面的 zoom()）。
    zoomControl: false,
    // 没有任何底图时也要能拖动/缩放：给一个空白的 L.CRS.EPSG3857 视口
    center: [0, 0],
    zoom: 2,
    worldCopyJump: true,
  });
  // scale bar + attribution + 信息角标**全部归右上**：三处分散 → 一处（用户要求）
  L.control.scale({ imperial: false, position: "topright" }).addTo(map);
  L.control.attribution({ position: "topright", prefix: false }).addTo(map);

  const layer = L.geoJSON(data, {
    // 点要素用圆点画：绕开 leaflet 默认图标 PNG 的资源路径
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, weight: 1.5 }),
    style: () => ({ color: "#4c8bf5", weight: 1.5, fillOpacity: 0.18 }),
    onEachFeature: (feature, featureLayer) => {
      const title = (feature.properties?.name ?? feature.properties?.NAME ?? feature.properties?.title) as string | undefined;
      if (title) featureLayer.bindTooltip(String(title));
      const entries = Object.entries(feature.properties ?? {}).slice(0, 12);
      if (entries.length) {
        featureLayer.bindPopup(
          `<b>${escapeHtml(String(title ?? "要素"))}</b><br>${entries
            .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v ?? ""))}`)
            .join("<br>")}`,
        );
      }
    },
  }).addTo(map);

  const bounds = layer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [16, 16], maxZoom: 18 });
  }

  // 在线底图：由头部按钮驱动（默认关闭；联网必须是用户的显式动作）
  let tiles: import("leaflet").TileLayer | null = null;
  const setBasemap = (on: boolean): boolean => {
    if (on && !tiles) {
      tiles = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
    } else if (!on && tiles) {
      map.removeLayer(tiles);
      tiles = null;
    }
    ctx.onBasemap?.(tiles !== null);
    return tiles !== null;
  };

  return {
    destroy() {
      map.remove();
    },
    // 缩放交给 Leaflet 自己的动画（fitBounds / zoomIn），与头部控件同源
    zoom(action) {
      if (action === "fit" || action === "fit-page") {
        let bounds = layer.getBounds();
        if (!bounds.isValid()) bounds = map.getBounds();
        map.fitBounds(bounds, { padding: [16, 16], maxZoom: 18 });
        return;
      }
      if (action === "fit-width") {
        map.fitBounds(layer.getBounds().isValid() ? layer.getBounds() : map.getBounds(), { padding: [8, 8] });
        return;
      }
      if (action === "in") map.zoomIn();
      else map.zoomOut();
    },
    toggleBasemap: setBasemap,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export const gisPlugin = {
  id: "gis",
  extensions: GIS_EXTENSIONS,
  // 缩放与底图开关都走**面板头部**：插件不再画自己的浮动控件/信息条
  tools: ["zoom", "basemap"] satisfies PreviewTool[],
  zoomModes: ["page"] satisfies ("width" | "page")[],
  render: renderGis,
};

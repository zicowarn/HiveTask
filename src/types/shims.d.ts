/**
 * 缺类型声明的三方库补齐（仅声明用到的部分，不引 `any` 扩散）。
 *
 * `@mapbox/togeojson` 在 npm 上没有 `@types` 包，这里按它的实际导出补最小声明：
 * `kml(doc)` / `gpx(doc)` 都吃 `Document`，吐 GeoJSON（FeatureCollection 或其数组）。
 */
declare module "@mapbox/togeojson" {
  export function kml(doc: Document): GeoJSON.FeatureCollection;
  export function gpx(doc: Document): GeoJSON.FeatureCollection;
  export function kmlWithFolders(doc: Document): GeoJSON.FeatureCollection;
  export function gpxGen(doc: Document): GeoJSON.FeatureCollection;
  const togeojson: {
    kml: typeof kml;
    gpx: typeof gpx;
    kmlWithFolders: typeof kmlWithFolders;
  };
  export default togeojson;
}

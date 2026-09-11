// One-off check: every zh-CN key exists in en-US with aligned {x} placeholders.
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");
const zh = read("src/i18n/zh-CN.ts");
const en = read("src/i18n/en-US.ts");

const parse = (src) => {
  const out = {};
  const re = /"([^"]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)")/g;
  for (const m of src.matchAll(re)) out[m[1]] = m[2];
  return out;
};

const Z = parse(zh);
const E = parse(en);
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");

let bad = 0;
for (const [k, v] of Object.entries(Z)) {
  if (!(k in E)) { console.log("EN missing:", k); bad++; continue; }
  if (ph(v) !== ph(E[k])) { console.log("Placeholder mismatch:", k, `[${ph(v)}] vs [${ph(E[k])}]`); bad++; }
}
console.log(bad === 0 ? `OK: ${Object.keys(Z).length} keys, placeholders aligned` : `${bad} problems`);
process.exit(bad === 0 ? 0 : 1);

/**
 * 油漆桶：扫描线洪水填充（纯函数，Vitest 直测）。
 *
 * - 在 `data`（RGBA，宽 `w` 高 `h`）上从 `(x, y)` 出发，把与起点颜色**逐通道差 ≤ tolerance**
 *   的连通区域改写为 `rgba`；
 * - tolerance > 0 是为了吃掉截图边缘的抗锯齿过渡带（0 = 只填完全同色，实际用不了）；
 * - 返回被改写的包围盒（撤销 patch 只存这块），没有改写（起点即目标色）返回 null。
 */

import type { Rect } from "./geometry";

export const FILL_TOLERANCE = 48;

export function floodFill(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  rgba: readonly [number, number, number],
  tolerance = FILL_TOLERANCE,
): Rect | null {
  if (w <= 0 || h <= 0) return null;
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const start = (sy * w + sx) * 4;
  const target = [data[start], data[start + 1], data[start + 2]];
  const [fr, fg, fb] = rgba;
  const near = (index: number): boolean => {
    for (let channel = 0; channel < 3; channel += 1) {
      if (Math.abs(data[index + channel] - target[channel]) > tolerance) return false;
    }
    return true;
  };
  // 起点本身就是目标色（差 ≤ tolerance 的自比恒真）→ 会把整个同族区域重刷一遍却看不出变化；
  // 直接判"改了也白改"省掉整张扫描
  if (Math.abs(data[start] - fr) <= 0 && Math.abs(data[start + 1] - fg) <= 0 && Math.abs(data[start + 2] - fb) <= 0) {
    return null;
  }
  const visited = new Uint8Array(w * h);
  const stack: number[] = [sx, sy];
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  while (stack.length > 0) {
    const cy = stack.pop()!;
    const cx = stack.pop()!;
    // 先向左走到头（该行连续段起点）
    let left = cx;
    while (left > 0 && !visited[cy * w + left - 1] && near((cy * w + left - 1) * 4)) left -= 1;
    let right = cx;
    while (right < w - 1 && !visited[cy * w + right + 1] && near((cy * w + right + 1) * 4)) right += 1;
    for (let px = left; px <= right; px += 1) {
      const index = cy * w + px;
      if (visited[index]) continue;
      visited[index] = 1;
      const byte = index * 4;
      data[byte] = fr;
      data[byte + 1] = fg;
      data[byte + 2] = fb;
      data[byte + 3] = 255;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      // 上下行的连续段入栈
      if (cy > 0) {
        const up = (cy - 1) * w + px;
        if (!visited[up] && near(up * 4)) stack.push(px, cy - 1);
      }
      if (cy < h - 1) {
        const down = (cy + 1) * w + px;
        if (!visited[down] && near(down * 4)) stack.push(px, cy + 1);
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

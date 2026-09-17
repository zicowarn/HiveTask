/**
 * 文档统计（字数）。
 *
 * 口径（中文写作场景的通行做法）：
 * - `chars` = **非空白字符数**（汉字、字母、数字、标点都算一个；换行/空格不计）；
 * - `words` = **拉丁词数**（连续字母/数字/下划线/撇号算一个词，`don't` 算一个）。
 *
 * 两者分开报，是因为"字数"在中英混排里不是同一个量：纯中文文档 words 为 0，
 * 状态栏就只显示字数（见 StatusBar 的条件渲染）。
 */

const LATIN_WORD = /[A-Za-z0-9][A-Za-z0-9_'’-]*/g;

export interface TextStats {
  chars: number;
  words: number;
}

export function countText(text: string): TextStats {
  let chars = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) chars += 1;
  }
  const words = text.match(LATIN_WORD)?.length ?? 0;
  return { chars, words };
}

/**
 * Display form of a git remote URL: "https://github.com/owner/repo.git" →
 * "owner/repo". Known hosts get the short form; anything else (SSH, self-
 * hosted Gitea, ...) shows the raw URL unchanged. The full URL stays in
 * tooltips.
 */
export function shortOrigin(url: string): string {
  const m = url.match(/(?:github|gitee|gitlab)\.com[/:](.+?)(?:\.git)?\/?$/i);
  return m ? m[1] : url;
}

/**
 * Display form of a local path: the user's home directory collapses to `~`
 * (`/Users/x/work/docs` → `~/work/docs`). Used by the knowledge-folder box in
 * the header, where the raw path otherwise crowds out the rest of the row;
 * the full path stays in the tooltip.
 */
export function shortPath(path: string): string {
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/);
  return home ? `~${path.slice(home[0].length)}` : path;
}

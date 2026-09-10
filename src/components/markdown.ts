/**
 * Strip HTML comments from GitHub markdown source. GitHub hides comment
 * blocks in rendered bodies, and PR templates often wrap their whole
 * checklist in one, so a non-empty raw body can have no visible content.
 */
export function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

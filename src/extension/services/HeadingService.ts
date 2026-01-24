import MarkdownIt from "markdown-it";
import GithubSlugger from "github-slugger";

export type Heading = {
  level: number;
  text: string;
  slug: string;
  startLine: number;
};

const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
});

export function extractHeadings(markdown: string): Heading[] {
  const tokens = md.parse(markdown, {});
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open") continue;
    const level = Number.parseInt(t.tag.replace(/^h/, ""), 10);
    const inline = tokens[i + 1];
    if (!inline || inline.type !== "inline") continue;
    const text = inline.content ?? "";
    const slug = slugger.slug(text);
    const startLine = Array.isArray(t.map) ? t.map[0] : 0;
    headings.push({ level, text, slug, startLine });
  }
  return headings;
}


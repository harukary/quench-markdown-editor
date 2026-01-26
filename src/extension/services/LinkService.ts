import * as path from "node:path";
import * as vscode from "vscode";
import { extractHeadings } from "./HeadingService";

export type ResolvedLink = {
  targetUri: vscode.Uri;
  fragment?: string;
};

export function splitHref(href: string): { pathPart: string; fragment?: string } {
  const hash = href.indexOf("#");
  if (hash === -1) return { pathPart: href };
  return { pathPart: href.slice(0, hash), fragment: href.slice(hash + 1) };
}

export function computeRelativeMarkdownPath(fromDocumentUri: vscode.Uri, to: vscode.Uri): string {
  if (fromDocumentUri.scheme !== to.scheme || fromDocumentUri.authority !== to.authority) {
    throw new Error("異なるscheme/authority間の相対パスは生成できません");
  }
  const fromDir = path.posix.dirname(fromDocumentUri.path);
  let rel = path.posix.relative(fromDir, to.path);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

export function resolveHrefToUri(fromUri: vscode.Uri, href: string): ResolvedLink | "external" {
  if (/^https?:\/\//i.test(href)) return "external";
  if (/^mailto:/i.test(href)) return "external";

  const { pathPart, fragment } = splitHref(href);
  if (pathPart.trim().length === 0) {
    return { targetUri: fromUri, fragment };
  }

  const folder = vscode.workspace.getWorkspaceFolder(fromUri);
  const basePath = pathPart.startsWith("/") && folder ? folder.uri.path : path.posix.dirname(fromUri.path);
  const resolvedPath = path.posix.normalize(path.posix.join(basePath, pathPart));
  const targetUri = fromUri.with({ path: resolvedPath });
  return { targetUri, fragment };
}

export async function openLink(fromUri: vscode.Uri, href: string): Promise<void> {
  const resolved = resolveHrefToUri(fromUri, href);
  if (resolved === "external") {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }

  const ext = path.posix.extname(resolved.targetUri.path).toLowerCase();
  if (ext && ext !== ".md") {
    // 画像やPDFなどは VSCode の既定ビューアに任せる（TextDocumentとして開くと失敗する場合がある）
    await vscode.commands.executeCommand("vscode.open", resolved.targetUri);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(resolved.targetUri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  if (resolved.fragment && resolved.fragment.length > 0) {
    const headings = extractHeadings(doc.getText());
    const hit = headings.find((h) => h.slug === resolved.fragment);
    if (hit) {
      const pos = new vscode.Position(hit.startLine, 0);
      const range = new vscode.Range(pos, pos);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
    }
  }
}

export async function getPreviewText(fromUri: vscode.Uri, href: string): Promise<{ title: string; text: string }> {
  const resolved = resolveHrefToUri(fromUri, href);
  if (resolved === "external") {
    return { title: href, text: href };
  }

  const rel = vscode.workspace.asRelativePath(resolved.targetUri);
  const ext = path.posix.extname(resolved.targetUri.path).toLowerCase();
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
  if (imageExts.has(ext)) {
    return { title: rel, text: "（画像ファイルのためテキストプレビューはありません）" };
  }
  if (ext && ext !== ".md") {
    return { title: rel, text: `（テキストプレビュー未対応: ${ext}）` };
  }

  const doc = await vscode.workspace.openTextDocument(resolved.targetUri);
  const text = doc.getText();
  const lines = text.split(/\r?\n/);

  if (resolved.fragment) {
    const headings = extractHeadings(text);
    const hit = headings.find((h) => h.slug === resolved.fragment);
    if (hit) {
      const start = hit.startLine;
      const excerpt = lines.slice(start, Math.min(lines.length, start + 12)).join("\n");
      return { title: `${vscode.workspace.asRelativePath(resolved.targetUri)}#${resolved.fragment}`, text: excerpt };
    }
  }

  const excerpt = lines.slice(0, 12).join("\n");
  return { title: rel, text: excerpt };
}

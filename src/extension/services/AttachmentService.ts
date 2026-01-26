import * as path from "node:path";
import * as vscode from "vscode";
import { getQuenchSettings } from "./Settings";
import { computeRelativeMarkdownPath } from "./LinkService";

export type CreateAttachmentInput = {
  fromDocumentUri: vscode.Uri;
  bytes: Uint8Array;
  filenameHint?: string;
  mime?: string;
};

export type CreateAttachmentResult = {
  savedUri: vscode.Uri;
  markdown: string;
};

export async function createImageAttachment(input: CreateAttachmentInput): Promise<CreateAttachmentResult> {
  const settings = getQuenchSettings(input.fromDocumentUri);
  const folder = vscode.workspace.getWorkspaceFolder(input.fromDocumentUri);
  if (!folder) throw new Error("Cannot save attachments for documents outside a workspace.");

  const noteDir = input.fromDocumentUri.with({ path: path.posix.dirname(input.fromDocumentUri.path) });
  const baseDir = resolveAttachmentBaseDir(folder.uri, noteDir, settings.attachments.location, settings.attachments);
  await vscode.workspace.fs.createDirectory(baseDir);

  const ext = guessImageExt(input.filenameHint, input.mime) ?? "png";
  const baseName = createBaseName(input.fromDocumentUri, settings.attachments.naming);
  const initial = `${baseName}.${ext}`;

  const targetUri = await allocateUniqueUri(baseDir, initial);
  await vscode.workspace.fs.writeFile(targetUri, input.bytes);

  const rel = computeRelativeMarkdownPath(input.fromDocumentUri, targetUri);
  const markdown = `![](${rel})`;
  return { savedUri: targetUri, markdown };
}

function resolveAttachmentBaseDir(
  workspaceRoot: vscode.Uri,
  noteDir: vscode.Uri,
  location: "workspaceRoot" | "specifiedFolder" | "sameFolder" | "subfolder",
  attachments: { folderPath: string; subfolderName: string }
): vscode.Uri {
  switch (location) {
    case "workspaceRoot":
      return workspaceRoot;
    case "specifiedFolder": {
      const rel = validateWorkspaceRelativePath(attachments.folderPath);
      if (!rel.ok) throw new Error(`Invalid attachments.folderPath: ${rel.reason}`);
      return vscode.Uri.joinPath(workspaceRoot, rel.path);
    }
    case "sameFolder":
      return noteDir;
    case "subfolder": {
      const name = validateSinglePathSegment(attachments.subfolderName);
      if (!name.ok) throw new Error(`Invalid attachments.subfolderName: ${name.reason}`);
      return vscode.Uri.joinPath(noteDir, name.segment);
    }
  }
}

async function allocateUniqueUri(dir: vscode.Uri, filename: string): Promise<vscode.Uri> {
  const parsed = path.posix.parse(filename);
  const base = parsed.name;
  const ext = parsed.ext;

  for (let i = 1; i <= 1000; i++) {
    const candidate = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
    const uri = vscode.Uri.joinPath(dir, candidate);
    try {
      await vscode.workspace.fs.stat(uri);
      continue;
    } catch {
      return uri;
    }
  }
  throw new Error("Too many attachment filename collisions (tried 1000 candidates).");
}

function createBaseName(fromDocumentUri: vscode.Uri, naming: "timestamp" | "noteNameTimestamp"): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(
    now.getMinutes()
  )}${pad2(now.getSeconds())}`;

  if (naming === "timestamp") {
    return ts;
  }

  const base = path.posix.basename(fromDocumentUri.path, path.posix.extname(fromDocumentUri.path));
  const safe = base.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe.length > 0 ? `${safe}-${ts}` : ts;
}

function guessImageExt(filenameHint?: string, mime?: string): string | undefined {
  const extFromName = filenameHint ? path.posix.extname(filenameHint).replace(/^\./, "").toLowerCase() : undefined;
  if (extFromName && /^[a-z0-9]+$/.test(extFromName)) return extFromName;

  const m = (mime ?? "").toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/jpeg") return "jpg";
  if (m === "image/gif") return "gif";
  if (m === "image/webp") return "webp";
  if (m === "image/svg+xml") return "svg";
  return undefined;
}

function validateWorkspaceRelativePath(input: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.includes("\\")) return { ok: false, reason: "backslash_not_allowed" };
  if (trimmed.startsWith("/")) return { ok: false, reason: "absolute_path_not_allowed" };
  if (trimmed.includes(":")) return { ok: false, reason: "scheme_or_drive_not_allowed" };
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return { ok: false, reason: "dot_segments_not_allowed" };
  return { ok: true, path: segments.join("/") };
}

function validateSinglePathSegment(input: string): { ok: true; segment: string } | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.includes("/") || trimmed.includes("\\")) return { ok: false, reason: "slash_not_allowed" };
  if (trimmed === "." || trimmed === "..") return { ok: false, reason: "dot_not_allowed" };
  if (trimmed.includes(":")) return { ok: false, reason: "colon_not_allowed" };
  return { ok: true, segment: trimmed };
}

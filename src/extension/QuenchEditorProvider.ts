import * as vscode from "vscode";
import { CssService } from "./services/CssService";
import {
  assertWebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  TextChange,
  WebviewToExtensionMessage
} from "../shared/protocol";
import { getQuenchSettings } from "./services/Settings";
import { WorkspaceIndex } from "./services/WorkspaceIndex";
import { createImageAttachment } from "./services/AttachmentService";
import { computeRelativeMarkdownPath, getPreviewText, openLink } from "./services/LinkService";
import { extractHeadings } from "./services/HeadingService";
import * as path from "node:path";

type EditorInstance = {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  cssService: CssService;
  disposables: vscode.Disposable[];
  pendingApplyQueue: string[];
};

export class QuenchEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "quench.markdownEditor";

  private readonly editorsByDocumentKey = new Map<string, Set<EditorInstance>>();
  private lastActiveEditor: EditorInstance | null = null;
  private readonly workspaceIndex = new WorkspaceIndex();

  constructor(private readonly context: vscode.ExtensionContext) {
    void this.workspaceIndex.rebuild();
  }

  dispose() {
    this.workspaceIndex.dispose();
  }

  async reloadCssForAllEditors(): Promise<void> {
    const editors = [...this.editorsByDocumentKey.values()].flatMap((set) => [...set.values()]);
    await Promise.all(
      editors.map(async (editor) => {
        const cssText = await editor.cssService.readAllCssText();
        editor.panel.webview.postMessage({ type: "CSS_UPDATED", cssText } satisfies ExtensionToWebviewMessage);
      })
    );
  }

  async rebuildWorkspaceIndex(): Promise<void> {
    await this.workspaceIndex.rebuild();
    vscode.window.showInformationMessage("Quench: Workspace index rebuilt.");
  }

  async createThemeCss(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      vscode.window.showErrorMessage("Quench: ワークスペースが開かれていません。");
      return;
    }

    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showQuickPick(
            folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
            { placeHolder: "テーマCSSを作成するワークスペースフォルダを選択" }
          ).then((p) => p?.folder);
    if (!folder) return;

    const rel = ".vscode/quench-theme.css";
    const fileUri = vscode.Uri.joinPath(folder.uri, rel);
    const dirUri = vscode.Uri.joinPath(folder.uri, ".vscode");

    try {
      await vscode.workspace.fs.stat(fileUri);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`Quench: 既に存在します: ${vscode.workspace.asRelativePath(fileUri)}`);
      return;
    } catch {
      // not exists -> create
    }

    const template = this.getThemeCssTemplate();

    await vscode.workspace.fs.createDirectory(dirUri);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(template, "utf8"));

    const cfg = vscode.workspace.getConfiguration("quench", folder.uri);
    const current = cfg.get<string[]>("css.files", []);
    const next = current.includes(rel) ? current : [...current, rel];
    await cfg.update("css.files", next, vscode.ConfigurationTarget.WorkspaceFolder);

    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Quench: テーマCSSを作成しました: ${vscode.workspace.asRelativePath(fileUri)}`);
    await this.reloadCssForAllEditors();
  }

  private getThemeCssTemplate(): string {
    return `/* Quench Theme CSS (workspace)

  生成先: .vscode/quench-theme.css
  このファイルは Quench の見た目を調整するための “Simple Theme” 風テンプレです。
  保存すると（quench.css.reloadOnSave がONなら）自動でQuenchに反映されます。

  反映対象: QuenchのWebview（#quench-user-css）
*/

:root {
  /* Accent (Obsidian-ish purple) */
  --quench-accent: #7c3aed;

  /* Links */
  --quench-link: color-mix(in srgb, var(--quench-accent) 82%, #fff 18%);
  --quench-link-active: color-mix(in srgb, var(--quench-accent) 62%, #fff 38%);

  /* Muted/syntax (dim markdown markers) */
  --quench-muted: color-mix(in srgb, var(--vscode-editor-foreground) 70%, var(--vscode-editor-background) 30%);

  /* Cursor (theme follow; set to #fff to force white) */
  --quench-cursor: var(--vscode-editorCursor-foreground);

  /* Inline code + code tokens */
  --quench-code-fg: color-mix(in srgb, var(--vscode-editor-foreground) 92%, #fff 8%);
  --quench-code-keyword: color-mix(in srgb, var(--quench-accent) 70%, #fff 30%);
  --quench-code-string: color-mix(in srgb, #22c55e 70%, #fff 30%);
  --quench-code-number: color-mix(in srgb, #f59e0b 70%, #fff 30%);
  --quench-code-comment: var(--quench-muted);
}

/* 例: 見出し色を変える */
/* .md-heading { color: var(--quench-accent); } */
`;
  }

  private async ensureThemeCss(folder: vscode.WorkspaceFolder): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("quench", folder.uri);
    const autoCreate = cfg.get<boolean>("theme.autoCreateCss", true);
    if (!autoCreate) return;

    const rel = ".vscode/quench-theme.css";
    const fileUri = vscode.Uri.joinPath(folder.uri, rel);
    const dirUri = vscode.Uri.joinPath(folder.uri, ".vscode");

    const current = cfg.get<string[]>("css.files", []);
    const needsConfigUpdate = !current.includes(rel);

    let exists = true;
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(this.getThemeCssTemplate(), "utf8"));
        vscode.window.showInformationMessage(`Quench: テーマCSSを自動生成しました: ${vscode.workspace.asRelativePath(fileUri)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Quench: テーマCSSの自動生成に失敗しました: ${message}`);
        return;
      }
    }

    if (needsConfigUpdate) {
      await cfg.update("css.files", [...current, rel], vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }

  async insertMarkdownLink(): Promise<void> {
    const target = await this.getCommandTarget();
    if (!target) return;

    const folder = vscode.workspace.getWorkspaceFolder(target.document.uri);
    const candidates = this.workspaceIndex.getMarkdownFiles(folder);
    if (candidates.length === 0) {
      vscode.window.showErrorMessage("Quench: ワークスペース内に .md が見つかりません。");
      return;
    }

    const items = candidates
      .filter((u) => u.toString() !== target.document.uri.toString())
      .map((u) => ({
        label: vscode.workspace.asRelativePath(u, false),
        description: "",
        uri: u
      }));

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "リンク先のMarkdownを選択" });
    if (!picked) return;

    const rel = computeRelativeMarkdownPath(target.document.uri, picked.uri);
    const label =
      target.selection.selectedText.length > 0
        ? target.selection.selectedText
        : path.posix.basename(picked.uri.path, path.posix.extname(picked.uri.path));
    const insert = `[${label}](${rel})`;
    await this.applyReplaceByOffsets(target.document, target.selection.selectionFrom, target.selection.selectionTo, insert, {
      ifSelectionNotEmpty: "replace"
    });
  }

  async insertLinkToHeading(): Promise<void> {
    const target = await this.getCommandTarget();
    if (!target) return;

    const folder = vscode.workspace.getWorkspaceFolder(target.document.uri);
    const candidates = this.workspaceIndex.getMarkdownFiles(folder);
    if (candidates.length === 0) {
      vscode.window.showErrorMessage("Quench: ワークスペース内に .md が見つかりません。");
      return;
    }

    const fileItems = candidates.map((u) => ({
      label: vscode.workspace.asRelativePath(u, false),
      uri: u
    }));

    const pickedFile = await vscode.window.showQuickPick(fileItems, { placeHolder: "見出しリンク対象のMarkdownを選択" });
    if (!pickedFile) return;

    const doc = await vscode.workspace.openTextDocument(pickedFile.uri);
    const headings = extractHeadings(doc.getText());
    if (headings.length === 0) {
      vscode.window.showErrorMessage("Quench: 対象ファイルに見出しがありません。");
      return;
    }

    const headingItems = headings.map((h) => ({
      label: `${"  ".repeat(Math.max(0, h.level - 1))}${h.text}`,
      description: `#${h.slug}`,
      heading: h
    }));

    const pickedHeading = await vscode.window.showQuickPick(headingItems, { placeHolder: "リンクする見出しを選択" });
    if (!pickedHeading) return;

    const rel = computeRelativeMarkdownPath(target.document.uri, pickedFile.uri);
    const href = `${rel}#${pickedHeading.heading.slug}`;
    const label = target.selection.selectedText.length > 0 ? target.selection.selectedText : pickedHeading.heading.text;
    const insert = `[${label}](${href})`;
    await this.applyReplaceByOffsets(target.document, target.selection.selectionFrom, target.selection.selectionTo, insert, {
      ifSelectionNotEmpty: "replace"
    });
  }

  async insertImageFromFile(): Promise<void> {
    const target = await this.getCommandTarget();
    if (!target) return;

    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "画像を選択して添付として挿入",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp", "svg"]
      }
    });
    if (!picked || picked.length === 0) return;

    try {
      const uri = picked[0];
      const bytes = await vscode.workspace.fs.readFile(uri);
      const result = await createImageAttachment({
        fromDocumentUri: target.document.uri,
        bytes,
        filenameHint: path.posix.basename(uri.path)
      });
      await this.applyReplaceByOffsets(target.document, target.selection.selectionFrom, target.selection.selectionTo, result.markdown, {
        ifSelectionNotEmpty: "replace"
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Quench: 画像添付に失敗しました: ${message}`);
    }
  }

  async resizeImage(): Promise<void> {
    const target = await this.getCommandTarget();
    if (!target) return;

    const sizeRaw = await vscode.window.showInputBox({
      prompt: "画像サイズ（GitHub互換）を入力",
      placeHolder: "例: 200 / 200x120（空でサイズ削除）"
    });
    if (sizeRaw === undefined) return;
    const sizeText = sizeRaw.trim();

    const selFrom = target.selection.selectionFrom;
    const selTo = target.selection.selectionTo;
    const selectionOverlaps = (from: number, to: number) => !(to <= selFrom || from >= selTo);
    const cursorOffset = selFrom;

    const pos = target.document.positionAt(cursorOffset);
    const line = target.document.lineAt(pos.line);
    const lineStartOffset = target.document.offsetAt(line.range.start);
    const text = line.text;

    type Match = { from: number; to: number; kind: "md" | "obs"; path: string; raw: string };
    const matches: Match[] = [];

    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const start = m.index ?? -1;
      if (start < 0) continue;
      const raw = m[0];
      matches.push({
        kind: "md",
        raw,
        path: (m[2] ?? "").trim(),
        from: lineStartOffset + start,
        to: lineStartOffset + start + raw.length
      });
    }
    for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
      const start = m.index ?? -1;
      if (start < 0) continue;
      const raw = m[0];
      matches.push({
        kind: "obs",
        raw,
        path: raw,
        from: lineStartOffset + start,
        to: lineStartOffset + start + raw.length
      });
    }

    const hit =
      matches.find((x) => selectionOverlaps(x.from, x.to)) ??
      matches.find((x) => cursorOffset >= x.from && cursorOffset <= x.to) ??
      null;

    if (!hit) {
      vscode.window.showErrorMessage("Quench: カーソル位置に画像が見つかりません。");
      return;
    }

    // 空ならサイズ削除（<img> の width/height を削除）
    if (sizeText.length === 0) {
      if (hit.kind === "obs") {
        // <img ...> から width/height を削除する
        const without = hit.raw
          .replace(/\swidth\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)/gi, "")
          .replace(/\sheight\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)/gi, "")
          .replace(/\s{2,}/g, " ");
        await this.applyReplaceByOffsets(target.document, hit.from, hit.to, without, { ifSelectionNotEmpty: "replace" });
      }
      return;
    }

    const sizeMatch = /^\s*(\d+)\s*(?:[x×]\s*(\d+)\s*)?$/.exec(sizeText);
    if (!sizeMatch) {
      vscode.window.showErrorMessage("Quench: サイズは数字または 幅x高さ の形式で入力してください（例: 200 / 200x120）。");
      return;
    }
    const w = Number(sizeMatch[1]);
    const h = sizeMatch[2] ? Number(sizeMatch[2]) : undefined;
    if (!Number.isFinite(w) || w <= 0 || (h != null && (!Number.isFinite(h) || h <= 0))) {
      vscode.window.showErrorMessage("Quench: サイズが不正です。");
      return;
    }
    if (hit.kind === "md") {
      // GitHub互換: Markdown画像 -> HTML img に変換して width/height を付与
      const mdMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(hit.raw.trim());
      const altRaw = mdMatch?.[1] ?? "";
      const src = hit.path;
      const attrs = h != null ? `width="${w}" height="${h}"` : `width="${w}"`;
      const altAttr = altRaw.trim().length > 0 ? ` alt="${altRaw.replace(/\"/g, "&quot;")}"` : "";
      const next = `<img src="${src}"${altAttr} ${attrs} />`;
      await this.applyReplaceByOffsets(target.document, hit.from, hit.to, next, { ifSelectionNotEmpty: "replace" });
      return;
    }

    // hit.kind === "obs": 既存の <img ...> を更新
    const srcMatch = /src\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))/i.exec(hit.raw);
    const src = (srcMatch?.[2] ?? srcMatch?.[3] ?? srcMatch?.[4] ?? "").trim();
    if (!src) {
      vscode.window.showErrorMessage("Quench: <img> に src が見つかりません。");
      return;
    }
    const altMatch = /alt\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))/i.exec(hit.raw);
    const alt = (altMatch?.[2] ?? altMatch?.[3] ?? altMatch?.[4] ?? "").trim();
    const attrs = h != null ? `width="${w}" height="${h}"` : `width="${w}"`;
    const altAttr = alt.length > 0 ? ` alt="${alt.replace(/\"/g, "&quot;")}"` : "";
    const next = `<img src="${src}"${altAttr} ${attrs} />`;
    await this.applyReplaceByOffsets(target.document, hit.from, hit.to, next, { ifSelectionNotEmpty: "replace" });
  }

  async insertEmbed(): Promise<void> {
    const settings = getQuenchSettings(this.lastActiveEditor?.document.uri);
    if (!settings.security.allowHtmlEmbeds) {
      vscode.window.showErrorMessage("Quench: HTML埋め込みは無効です（quench.security.allowHtmlEmbeds をONにしてください）。");
      return;
    }

    const target = await this.getCommandTarget();
    if (!target) return;

    const items = [
      { label: "audio", snippet: '<audio controls src=""></audio>' },
      { label: "video", snippet: '<video controls src=""></video>' },
      { label: "pdf (iframe)", snippet: '<iframe src=""></iframe>' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "挿入する埋め込みを選択" });
    if (!picked) return;
    if (picked.label.includes("iframe") && !settings.security.allowIframes) {
      vscode.window.showErrorMessage("Quench: iframeは無効です（quench.security.allowIframes をONにしてください）。");
      return;
    }

    await this.applyReplaceByOffsets(target.document, target.selection.selectionFrom, target.selection.selectionTo, picked.snippet, {
      ifSelectionNotEmpty: "replace"
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) {
      await this.ensureThemeCss(folder);
    }

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)]
    };

    const cssService = new CssService(document, panel, this.context);
    const editor: EditorInstance = { panel, document, cssService, disposables: [], pendingApplyQueue: [] };
    this.trackEditor(editor);

    let gotAnyWebviewMessage = false;
    const bootTimeout = setTimeout(() => {
      if (gotAnyWebviewMessage) return;
      vscode.window.showErrorMessage("Quench: Webview から応答がありません（起動に失敗している可能性があります）。");
    }, 30000);

    editor.disposables.push(
      panel.webview.onDidReceiveMessage(async (raw) => {
        try {
          gotAnyWebviewMessage = true;
          clearTimeout(bootTimeout);
          const msg = assertWebviewToExtensionMessage(raw);
          await this.handleWebviewMessage(editor, msg);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[quench] Invalid webview message:", err);
          vscode.window.showErrorMessage(`Quench: Webview message error: ${message}`);
          panel.webview.postMessage({ type: "ERROR", message, detail: String(raw) } satisfies ExtensionToWebviewMessage);
        }
      })
    );

    // HTMLを先に設定してwebviewをロード
    panel.webview.html = this.renderWebviewHtml(panel.webview);
    console.log("[quench] HTML set, sending INIT...");

    const settings = getQuenchSettings(document.uri);
    const cssText = await cssService.readAllCssText();
    panel.webview.postMessage({
      type: "INIT",
      documentUri: document.uri.toString(),
      text: document.getText(),
      version: document.version,
      settings,
      cssText
    } satisfies ExtensionToWebviewMessage);

    editor.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        this.onDidChangeDocument(editor, e.contentChanges);
      })
    );

    editor.disposables.push(
      cssService.onCssUpdated(async () => {
        const cssText = await cssService.readAllCssText();
        panel.webview.postMessage({ type: "CSS_UPDATED", cssText } satisfies ExtensionToWebviewMessage);
      })
    );

    editor.disposables.push(
      panel.onDidDispose(() => {
        clearTimeout(bootTimeout);
        editor.disposables.forEach((d) => d.dispose());
        cssService.dispose();
        this.untrackEditor(editor);
      })
    );

    editor.disposables.push(
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.lastActiveEditor = editor;
      })
    );
  }

  private async handleWebviewMessage(editor: EditorInstance, msg: WebviewToExtensionMessage): Promise<void> {
    if (msg.type === "WEBVIEW_READY") {
      // resolveCustomTextEditor() 側で待ち合わせるため、ここでは何もしない。
      return;
    }

    if (msg.type === "BOOT_ERROR") {
      vscode.window.showErrorMessage(`Quench: Webview boot error: ${msg.message}`);
      console.error("[quench] Webview boot error:", msg.message, msg.detail ?? "");
      return;
    }

    if (msg.type === "REQUEST_DOC_RESYNC") {
      editor.pendingApplyQueue.length = 0;
      editor.panel.webview.postMessage({
        type: "DOC_RESYNC",
        text: editor.document.getText(),
        version: editor.document.version,
        reason: "requested"
      } satisfies ExtensionToWebviewMessage);
      return;
    }

    if (msg.type === "APPLY_EDIT") {
      if (editor.document.version !== msg.baseVersion) {
        editor.panel.webview.postMessage({
          type: "APPLY_EDIT_RESULT",
          requestId: msg.requestId,
          applied: false,
          version: editor.document.version,
          error: "version_mismatch"
        } satisfies ExtensionToWebviewMessage);
        editor.panel.webview.postMessage({
          type: "DOC_RESYNC",
          text: editor.document.getText(),
          version: editor.document.version,
          reason: "version_mismatch"
        } satisfies ExtensionToWebviewMessage);
        return;
      }

      editor.pendingApplyQueue.push(msg.requestId);

      const edit = new vscode.WorkspaceEdit();
      const sorted = [...msg.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
      for (const c of sorted) {
        const start = editor.document.positionAt(c.rangeOffset);
        const end = editor.document.positionAt(c.rangeOffset + c.rangeLength);
        edit.replace(editor.document.uri, new vscode.Range(start, end), c.text);
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        const requestId = editor.pendingApplyQueue.shift();
        if (requestId) {
          editor.panel.webview.postMessage({
            type: "APPLY_EDIT_RESULT",
            requestId,
            applied: false,
            version: editor.document.version,
            error: "applyEdit_failed"
          } satisfies ExtensionToWebviewMessage);
        }
        vscode.window.showErrorMessage("Quench: Failed to apply edit to document.");
      }
      return;
    }

    if (msg.type === "REQUEST_SELECTION") {
      editor.panel.webview.postMessage({
        type: "ERROR",
        message: "Quench: REQUEST_SELECTION はExtension→Webviewのメッセージです（Webview→Extensionではありません）"
      } satisfies ExtensionToWebviewMessage);
      return;
    }

    if (msg.type === "SELECTION_RESULT") {
      // requestSelectionFromWebview() の待受け用。ここでは何もしない。
      return;
    }

    if (msg.type === "OPEN_LINK") {
      try {
        await openLink(editor.document.uri, msg.href);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Quench: リンクを開けませんでした: ${message}`);
      }
      return;
    }

    if (msg.type === "REQUEST_PREVIEW") {
      try {
        const preview = await getPreviewText(editor.document.uri, msg.href);
        editor.panel.webview.postMessage({
          type: "PREVIEW_RESULT",
          requestId: msg.requestId,
          title: preview.title,
          text: preview.text
        } satisfies ExtensionToWebviewMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        editor.panel.webview.postMessage({
          type: "PREVIEW_RESULT",
          requestId: msg.requestId,
          title: "プレビュー生成失敗",
          text: message
        } satisfies ExtensionToWebviewMessage);
      }
      return;
    }

    if (msg.type === "REQUEST_RESOURCE_URI") {
      const settings = getQuenchSettings(editor.document.uri);
      if (msg.kind === "image") {
        const requestId = msg.requestId;
        try {
          if (/^https?:\/\//i.test(msg.href)) {
            if (!settings.security.allowExternalImages) {
              editor.panel.webview.postMessage({
                type: "RESOURCE_URI_RESULT",
                requestId,
                ok: false,
                error: "external_images_disabled"
              } satisfies ExtensionToWebviewMessage);
              return;
            }
            editor.panel.webview.postMessage({
              type: "RESOURCE_URI_RESULT",
              requestId,
              ok: true,
              uri: msg.href
            } satisfies ExtensionToWebviewMessage);
            return;
          }

          const from = editor.document.uri;
          const { pathPart } = msg.href.includes("#") ? { pathPart: msg.href.split("#")[0] } : { pathPart: msg.href };
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from.path), pathPart));
          const target = from.with({ path: resolved });
          try {
            await vscode.workspace.fs.stat(target);
          } catch {
            editor.panel.webview.postMessage({
              type: "RESOURCE_URI_RESULT",
              requestId,
              ok: false,
              error: "not_found"
            } satisfies ExtensionToWebviewMessage);
            return;
          }
          const uri = editor.panel.webview.asWebviewUri(target).toString();
          editor.panel.webview.postMessage({
            type: "RESOURCE_URI_RESULT",
            requestId,
            ok: true,
            uri
          } satisfies ExtensionToWebviewMessage);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          editor.panel.webview.postMessage({
            type: "RESOURCE_URI_RESULT",
            requestId,
            ok: false,
            error: message
          } satisfies ExtensionToWebviewMessage);
        }
      }
      return;
    }

    if (msg.type === "CREATE_ATTACHMENT") {
      const requestId = msg.requestId;
      try {
        if (editor.document.version !== msg.baseVersion) {
          throw new Error("version_mismatch");
        }
        const result = await createImageAttachment({
          fromDocumentUri: editor.document.uri,
          bytes: msg.bytes,
          filenameHint: msg.filenameHint,
          mime: msg.mime
        });

        await this.applyReplaceByOffsets(editor.document, msg.insertFrom, msg.insertTo, result.markdown, {
          ifSelectionNotEmpty: "replace"
        });

        editor.panel.webview.postMessage({
          type: "CREATE_ATTACHMENT_RESULT",
          requestId,
          ok: true
        } satisfies ExtensionToWebviewMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Quench: 添付の保存に失敗しました: ${message}`);
        editor.panel.webview.postMessage({
          type: "CREATE_ATTACHMENT_RESULT",
          requestId,
          ok: false,
          error: message
        } satisfies ExtensionToWebviewMessage);
        if (message === "version_mismatch") {
          editor.pendingApplyQueue.length = 0;
          editor.panel.webview.postMessage({
            type: "DOC_RESYNC",
            text: editor.document.getText(),
            version: editor.document.version,
            reason: "version_mismatch"
          } satisfies ExtensionToWebviewMessage);
        }
      }
      return;
    }

    if (msg.type === "INSERT_IMAGE_REFERENCE") {
      const requestId = msg.requestId;
      try {
        if (editor.document.version !== msg.baseVersion) {
          throw new Error("version_mismatch");
        }
        const targetUri = vscode.Uri.parse(msg.targetUri);
        const docFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const targetFolder = vscode.workspace.getWorkspaceFolder(targetUri);
        if (!docFolder || !targetFolder || docFolder.uri.toString() !== targetFolder.uri.toString()) {
          throw new Error("ワークスペース内の同一ルートのファイルのみ参照リンクにできます");
        }
        const rel = computeRelativeMarkdownPath(editor.document.uri, targetUri);
        const markdown = `![](${rel})`;
        await this.applyReplaceByOffsets(editor.document, msg.insertFrom, msg.insertTo, markdown, {
          ifSelectionNotEmpty: "replace"
        });
        editor.panel.webview.postMessage({
          type: "CREATE_ATTACHMENT_RESULT",
          requestId,
          ok: true
        } satisfies ExtensionToWebviewMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        editor.panel.webview.postMessage({
          type: "CREATE_ATTACHMENT_RESULT",
          requestId,
          ok: false,
          error: message
        } satisfies ExtensionToWebviewMessage);
        if (message === "version_mismatch") {
          editor.pendingApplyQueue.length = 0;
          editor.panel.webview.postMessage({
            type: "DOC_RESYNC",
            text: editor.document.getText(),
            version: editor.document.version,
            reason: "version_mismatch"
          } satisfies ExtensionToWebviewMessage);
        }
      }
      return;
    }
  }

  private onDidChangeDocument(editor: EditorInstance, changes: readonly vscode.TextDocumentContentChangeEvent[]) {
    if (editor.pendingApplyQueue.length > 0) {
      const requestId = editor.pendingApplyQueue.shift();
      if (!requestId) return;
      editor.panel.webview.postMessage({
        type: "APPLY_EDIT_RESULT",
        requestId,
        applied: true,
        version: editor.document.version
      } satisfies ExtensionToWebviewMessage);
      return;
    }

    const mapped: TextChange[] = changes.map((c) => {
      const rangeOffset = typeof (c as any).rangeOffset === "number" ? (c as any).rangeOffset : editor.document.offsetAt(c.range.start);
      return { rangeOffset, rangeLength: c.rangeLength, text: c.text };
    });

    editor.panel.webview.postMessage({
      type: "DOC_PATCH",
      version: editor.document.version,
      changes: mapped
    } satisfies ExtensionToWebviewMessage);
  }

  private renderWebviewHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const cacheBust = nonce;
    const scriptUri = `${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"))}?v=${cacheBust}`;
    const baseCssUri = `${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "base.css"))}?v=${cacheBust}`;

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; connect-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${baseCssUri}" />
    <style id="quench-user-css"></style>
    <title>Quench</title>
  </head>
  <body>
    <div id="root">
      <div id="editor" role="application" aria-label="Quench Markdown Editor"></div>
      <div id="preview" hidden></div>
      <div id="banner" hidden></div>
    </div>
    <script nonce="${nonce}">
      (function () {
        const vscode = acquireVsCodeApi();
        window.__quench_vscode = vscode;
        const queue = [];
        let handler = null;

        function post(msg) {
          try {
            vscode.postMessage(msg);
          } catch (e) {
            // no-op
          }
        }

        window.__quench_boot = {
          setHandler(nextHandler) {
            handler = nextHandler;
            while (queue.length > 0) {
              const ev = queue.shift();
              try {
                handler(ev);
              } catch (e) {
                post({
                  type: "BOOT_ERROR",
                  message: e instanceof Error ? e.message : String(e),
                  detail: e instanceof Error ? e.stack : undefined
                });
              }
            }
          }
        };

        window.addEventListener("message", (ev) => {
          if (handler) handler(ev);
          else queue.push(ev);
        });

        window.addEventListener("error", (ev) => {
          post({
            type: "BOOT_ERROR",
            message: ev && ev.message ? String(ev.message) : "window.error",
            detail: ev && ev.error && ev.error.stack ? String(ev.error.stack) : undefined
          });
        });
        window.addEventListener("unhandledrejection", (ev) => {
          const reason = ev && ev.reason ? ev.reason : "unhandledrejection";
          post({
            type: "BOOT_ERROR",
            message: reason instanceof Error ? reason.message : String(reason),
            detail: reason instanceof Error ? reason.stack : undefined
          });
        });

        post({ type: "WEBVIEW_READY" });

        const script = document.createElement("script");
        script.src = "${scriptUri}";
        script.nonce = "${nonce}";
        script.addEventListener("error", () => {
          post({ type: "BOOT_ERROR", message: "Failed to load webview.js", detail: script.src });
        });
        document.body.appendChild(script);
      })();
    </script>
  </body>
</html>`;
  }

  private getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  private keyFor(document: vscode.TextDocument): string {
    return document.uri.toString();
  }

  private trackEditor(editor: EditorInstance) {
    const key = this.keyFor(editor.document);
    const set = this.editorsByDocumentKey.get(key) ?? new Set<EditorInstance>();
    set.add(editor);
    this.editorsByDocumentKey.set(key, set);
  }

  private untrackEditor(editor: EditorInstance) {
    const key = this.keyFor(editor.document);
    const set = this.editorsByDocumentKey.get(key);
    if (!set) return;
    set.delete(editor);
    if (set.size === 0) this.editorsByDocumentKey.delete(key);
    if (this.lastActiveEditor === editor) this.lastActiveEditor = null;
  }

  private async getCommandTarget(): Promise<
    | {
        document: vscode.TextDocument;
        noteDir: vscode.Uri;
        selection: { selectionFrom: number; selectionTo: number; selectedText: string };
      }
    | null
  > {
    // Custom Editor優先（Quench上でのコマンド利用を想定）
    const active = this.lastActiveEditor;
    if (active) {
      const selection = await this.requestSelectionFromWebview(active);
      if (!selection) return null;
      const noteDir = active.document.uri.with({ path: path.posix.dirname(active.document.uri.path) });
      return { document: active.document, noteDir, selection };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("Quench: 対象エディタが見つかりません。");
      return null;
    }

    const doc = editor.document;
    const noteDir = doc.uri.with({ path: path.posix.dirname(doc.uri.path) });
    const from = doc.offsetAt(editor.selection.start);
    const to = doc.offsetAt(editor.selection.end);
    const selectedText = doc.getText(editor.selection);
    return { document: doc, noteDir, selection: { selectionFrom: from, selectionTo: to, selectedText } };
  }

  private async requestSelectionFromWebview(editor: EditorInstance): Promise<{
    selectionFrom: number;
    selectionTo: number;
    selectedText: string;
  } | null> {
    const requestId = `sel_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const response = await this.waitForWebviewMessage(editor.panel.webview, (m): m is WebviewToExtensionMessage => {
      return typeof m === "object" && m !== null && (m as any).type === "SELECTION_RESULT" && (m as any).requestId === requestId;
    }, async () => {
      editor.panel.webview.postMessage({ type: "REQUEST_SELECTION", requestId } satisfies ExtensionToWebviewMessage);
    });

    if (response.type !== "SELECTION_RESULT") return null;
    if (editor.document.version !== response.baseVersion) {
      vscode.window.showErrorMessage("Quench: 未確定の編集があるか、ドキュメントが更新されたため再同期します。");
      editor.pendingApplyQueue.length = 0;
      editor.panel.webview.postMessage({
        type: "DOC_RESYNC",
        text: editor.document.getText(),
        version: editor.document.version,
        reason: "external_change"
      } satisfies ExtensionToWebviewMessage);
      return null;
    }

    return { selectionFrom: response.selectionFrom, selectionTo: response.selectionTo, selectedText: response.selectedText };
  }

  private async waitForWebviewMessage<T extends WebviewToExtensionMessage>(
    webview: vscode.Webview,
    predicate: (value: any) => value is T,
    trigger: () => Promise<void>,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 3000;
      const timeout = setTimeout(() => {
        disposable.dispose();
        reject(new Error("timeout"));
      }, timeoutMs);

      const disposable = webview.onDidReceiveMessage((m) => {
        if (!predicate(m)) return;
        clearTimeout(timeout);
        disposable.dispose();
        resolve(m);
      });

      trigger().catch((e) => {
        clearTimeout(timeout);
        disposable.dispose();
        reject(e);
      });
    });
  }

  private async applyReplaceByOffsets(
    document: vscode.TextDocument,
    fromOffset: number,
    toOffset: number,
    text: string,
    _options: { ifSelectionNotEmpty: "replace" }
  ): Promise<void> {
    const start = document.positionAt(fromOffset);
    const end = document.positionAt(toOffset);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(start, end), text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error("WorkspaceEdit の適用に失敗しました");
  }
}

import * as vscode from "vscode";
import { CssService } from "./services/CssService";
import {
  assertWebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  QuenchThemeKind,
  QuenchSettings,
  TextChange,
  WebviewToExtensionMessage
} from "../shared/protocol";
import { getQuenchSettings } from "./services/Settings";
import { WorkspaceIndex } from "./services/WorkspaceIndex";
import { createImageAttachment } from "./services/AttachmentService";
import { computeRelativeMarkdownPath, getPreviewText, openLink } from "./services/LinkService";
import { extractHeadings } from "./services/HeadingService";
import * as path from "node:path";
import { GlobalSettingsService, QuenchGlobalOverrides } from "./services/GlobalSettingsService";

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
  private currentThemeKind: QuenchThemeKind;
  private readonly globalSettings: GlobalSettingsService;
  private globalOverrides: QuenchGlobalOverrides | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentThemeKind = this.computeThemeKind(vscode.window.activeColorTheme.kind);
    this.globalSettings = new GlobalSettingsService(context);
    this.context.subscriptions.push(this.globalSettings);
    this.context.subscriptions.push(
      this.globalSettings.onDidChange(async () => {
        await this.reloadGlobalOverrides();
        await this.reloadCssForAllEditors();
        this.broadcastSettingsUpdated();
      })
    );
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme((theme) => {
        this.currentThemeKind = this.computeThemeKind(theme.kind);
        this.broadcastThemeChanged();
      })
    );
    void this.workspaceIndex.rebuild();
    void this.reloadGlobalOverrides().then(() => {
      // If any editor opened before global overrides finished loading, update it now.
      void this.reloadCssForAllEditors();
      this.broadcastSettingsUpdated();
    });
  }

  dispose() {
    this.workspaceIndex.dispose();
  }

  private async reloadGlobalOverrides() {
    this.globalOverrides = await this.globalSettings.readOverrides();
  }

  private getEffectiveSettings(resource: vscode.Uri): QuenchSettings {
    const base = getQuenchSettings(resource);
    const o = this.globalOverrides;
    if (!o) return base;

    const next: QuenchSettings = {
      ...base,
      editor: {
        ...base.editor,
        ...(o.editor ?? {})
      },
      keybindings: o.keybindings ?? base.keybindings,
      syntaxVisibility: o.preview?.syntaxVisibility ?? base.syntaxVisibility,
      previewOnHover: o.links?.previewOnHover ?? base.previewOnHover,
      security: {
        ...base.security,
        ...(o.security ?? {})
      }
    };
    return next;
  }

  private buildGlobalThemeCss(): string {
    const o = this.globalOverrides;
    if (!o?.theme) return "";
    const lines: string[] = [];
    const t = o.theme;

    lines.push(":root {");
    if (t.accentDark) lines.push(`  --quench-accent: ${t.accentDark};`);
    if (t.cursorDark) lines.push(`  --quench-cursor: ${t.cursorDark};`);
    if (t.linkModHoverDark) lines.push(`  --quench-link-mod-hover: ${t.linkModHoverDark};`);
    lines.push("}");

    if (t.accentLight || t.cursorLight || t.linkModHoverLight) {
      lines.push('body[data-quench-theme-kind="light"],');
      lines.push('body[data-quench-theme-kind="high-contrast-light"] {');
      if (t.accentLight) lines.push(`  --quench-accent: ${t.accentLight};`);
      if (t.cursorLight) lines.push(`  --quench-cursor: ${t.cursorLight};`);
      if (t.linkModHoverLight) lines.push(`  --quench-link-mod-hover: ${t.linkModHoverLight};`);
      lines.push("}");
    }

    // Ensure the cursor override actually takes effect even if workspace CSS
    // overrides CodeMirror cursor styling (caret-color / border-left-color).
      if (t.cursorDark || t.cursorLight) {
        lines.push("");
        lines.push("/* Cursor override */");
        lines.push(".cm-content { caret-color: var(--quench-cursor) !important; }");
        lines.push(".cm-cursor, .cm-dropCursor { border-left-color: var(--quench-cursor) !important; }");
      }

    return lines.join("\n");
  }

  private async computeCssTextForEditor(editor: EditorInstance): Promise<string[]> {
    const globalCss = this.buildGlobalThemeCss();
    const cssText = await editor.cssService.readAllCssText();
    // Precedence (later wins within #quench-user-css):
    // - Workspace/user CSS (quench.css.files)
    // - Global theme overrides (this UI)
    //
    // Rationale: The Settings UI is the primary "theme override" surface.
    // Users can still override it by clearing values (inherit) or not using global overrides.
    return globalCss.length > 0 ? [...cssText, globalCss] : cssText;
  }

  private broadcastSettingsUpdated() {
    for (const set of this.editorsByDocumentKey.values()) {
      for (const editor of set.values()) {
        editor.panel.webview.postMessage({
          type: "SETTINGS_UPDATED",
          settings: this.getEffectiveSettings(editor.document.uri)
        } satisfies ExtensionToWebviewMessage);
      }
    }
  }

  private computeThemeKind(kind: vscode.ColorThemeKind): QuenchThemeKind {
    switch (kind) {
      case vscode.ColorThemeKind.Light:
        return "light";
      case vscode.ColorThemeKind.Dark:
        return "dark";
      case vscode.ColorThemeKind.HighContrast:
        return "high-contrast";
      case vscode.ColorThemeKind.HighContrastLight:
        return "high-contrast-light";
      default:
        return "dark";
    }
  }

  private broadcastThemeChanged() {
    for (const set of this.editorsByDocumentKey.values()) {
      for (const editor of set.values()) {
        editor.panel.webview.postMessage({
          type: "THEME_CHANGED",
          themeKind: this.currentThemeKind
        } satisfies ExtensionToWebviewMessage);
      }
    }
  }

  async reloadCssForAllEditors(): Promise<void> {
    const editors = [...this.editorsByDocumentKey.values()].flatMap((set) => [...set.values()]);
    await Promise.all(
      editors.map(async (editor) => {
        const cssText = await this.computeCssTextForEditor(editor);
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
      vscode.window.showErrorMessage("Quench: No workspace folder is open.");
      return;
    }

    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showQuickPick(
            folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
            { placeHolder: "Select a workspace folder to create theme CSS" }
          ).then((p) => p?.folder);
    if (!folder) return;

    const rel = ".vscode/quench-theme.css";
    const fileUri = vscode.Uri.joinPath(folder.uri, rel);
    const dirUri = vscode.Uri.joinPath(folder.uri, ".vscode");

    try {
      await vscode.workspace.fs.stat(fileUri);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`Quench: Already exists: ${vscode.workspace.asRelativePath(fileUri)}`);
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
    vscode.window.showInformationMessage(`Quench: Theme CSS created: ${vscode.workspace.asRelativePath(fileUri)}`);
    await this.reloadCssForAllEditors();
  }

  async openSettings(): Promise<void> {
    const panel = vscode.window.createWebviewPanel("quench.settings", "Quench Settings", vscode.ViewColumn.Active, {
      enableScripts: true
    });

    panel.webview.html = this.renderSettingsHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (raw) => {
      if (!raw || typeof raw !== "object") return;
      const type = (raw as any).type;
      if (type === "SETTINGS_UI_READY") {
        const resource =
          this.lastActiveEditor?.document.uri ??
          vscode.workspace.workspaceFolders?.[0]?.uri ??
          // Fallback to global scope (no resource)
          undefined;
        const overrides = (await this.globalSettings.readOverrides()) ?? {};
        const effectiveSettings = resource ? this.getEffectiveSettings(resource) : getQuenchSettings();
        const theme = {
          // Defaults are aligned with media/base.css
          accentDark: overrides.theme?.accentDark ?? "#7c3aed",
          accentLight: overrides.theme?.accentLight ?? "#6d28d9",
          cursorDark: overrides.theme?.cursorDark ?? "#ffffff",
          cursorLight: overrides.theme?.cursorLight ?? "",
          linkModHoverDark: overrides.theme?.linkModHoverDark ?? "#7dd3fc",
          linkModHoverLight: overrides.theme?.linkModHoverLight ?? "#0284c7"
        };
        panel.webview.postMessage({
          type: "SETTINGS_UI_INIT",
          filePath: this.globalSettings.getFileUri().fsPath,
          overrides,
          effective: {
            settings: effectiveSettings,
            theme
          }
        });
        return;
      }

      if (type === "SAVE_GLOBAL_SETTINGS") {
        const overrides = (raw as any).overrides as unknown;
        try {
          // Reuse the service validation by writing and reading back.
          if (typeof overrides !== "object" || overrides === null) throw new Error("Invalid overrides (must be an object).");
          await this.globalSettings.writeOverrides(overrides as QuenchGlobalOverrides);
          await this.reloadGlobalOverrides();
          await this.reloadCssForAllEditors();
          this.broadcastSettingsUpdated();
          panel.webview.postMessage({ type: "SAVE_OK" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          panel.webview.postMessage({ type: "SAVE_ERROR", message });
        }
      }
    });
  }

  private getThemeCssTemplate(): string {
    return `/* Quench Theme CSS (workspace)

  Path: .vscode/quench-theme.css
  This file is a "Simple Theme" style template for Quench.
  If quench.css.reloadOnSave is enabled, saving this file auto-reloads the Webview CSS.

  Target: Quench Webview (#quench-user-css)
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

/* Example: customize heading color */
/* .md-heading { color: var(--quench-accent); } */
`;
  }

  private async ensureThemeCss(folder: vscode.WorkspaceFolder): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("quench", folder.uri);
    const autoCreate = cfg.get<boolean>("theme.autoCreateCss", false);
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
        vscode.window.showInformationMessage(`Quench: Theme CSS auto-created: ${vscode.workspace.asRelativePath(fileUri)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Quench: Failed to auto-create theme CSS: ${message}`);
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
      vscode.window.showErrorMessage("Quench: No .md files found in the workspace.");
      return;
    }

    const items = candidates
      .filter((u) => u.toString() !== target.document.uri.toString())
      .map((u) => ({
        label: vscode.workspace.asRelativePath(u, false),
        description: "",
        uri: u
      }));

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a Markdown file to link to" });
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
      vscode.window.showErrorMessage("Quench: No .md files found in the workspace.");
      return;
    }

    const fileItems = candidates.map((u) => ({
      label: vscode.workspace.asRelativePath(u, false),
      uri: u
    }));

    const pickedFile = await vscode.window.showQuickPick(fileItems, { placeHolder: "Select a Markdown file for heading links" });
    if (!pickedFile) return;

    const doc = await vscode.workspace.openTextDocument(pickedFile.uri);
    const headings = extractHeadings(doc.getText());
    if (headings.length === 0) {
      vscode.window.showErrorMessage("Quench: No headings found in the selected file.");
      return;
    }

    const headingItems = headings.map((h) => ({
      label: `${"  ".repeat(Math.max(0, h.level - 1))}${h.text}`,
      description: `#${h.slug}`,
      heading: h
    }));

    const pickedHeading = await vscode.window.showQuickPick(headingItems, { placeHolder: "Select a heading to link to" });
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
      openLabel: "Select an image to insert as an attachment",
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
      vscode.window.showErrorMessage(`Quench: Failed to attach image: ${message}`);
    }
  }

  async resizeImage(): Promise<void> {
    const target = await this.getCommandTarget();
    if (!target) return;

    const sizeRaw = await vscode.window.showInputBox({
      prompt: "Enter image size (GitHub-compatible)",
      placeHolder: "e.g. 200 / 200x120 (empty to remove size)"
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
      vscode.window.showErrorMessage("Quench: No image found at the cursor.");
      return;
    }

    // Empty input removes size (deletes width/height from <img>)
    if (sizeText.length === 0) {
      if (hit.kind === "obs") {
        // Delete width/height from <img ...>
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
      vscode.window.showErrorMessage('Quench: Size must be a number or "WIDTHxHEIGHT" (e.g. 200 / 200x120).');
      return;
    }
    const w = Number(sizeMatch[1]);
    const h = sizeMatch[2] ? Number(sizeMatch[2]) : undefined;
    if (!Number.isFinite(w) || w <= 0 || (h != null && (!Number.isFinite(h) || h <= 0))) {
      vscode.window.showErrorMessage("Quench: Invalid size.");
      return;
    }
    if (hit.kind === "md") {
      // GitHub-friendly: convert Markdown image to HTML <img> with width/height
      const mdMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(hit.raw.trim());
      const altRaw = mdMatch?.[1] ?? "";
      const src = hit.path;
      const attrs = h != null ? `width="${w}" height="${h}"` : `width="${w}"`;
      const altAttr = altRaw.trim().length > 0 ? ` alt="${altRaw.replace(/\"/g, "&quot;")}"` : "";
      const next = `<img src="${src}"${altAttr} ${attrs} />`;
      await this.applyReplaceByOffsets(target.document, hit.from, hit.to, next, { ifSelectionNotEmpty: "replace" });
      return;
    }

    // hit.kind === "obs": update existing <img ...>
    const srcMatch = /src\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))/i.exec(hit.raw);
    const src = (srcMatch?.[2] ?? srcMatch?.[3] ?? srcMatch?.[4] ?? "").trim();
    if (!src) {
      vscode.window.showErrorMessage("Quench: <img> tag has no src attribute.");
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
      vscode.window.showErrorMessage("Quench: HTML embeds are disabled. Enable quench.security.allowHtmlEmbeds.");
      return;
    }

    const target = await this.getCommandTarget();
    if (!target) return;

    const items = [
      { label: "audio", snippet: '<audio controls src=""></audio>' },
      { label: "video", snippet: '<video controls src=""></video>' },
      { label: "pdf (iframe)", snippet: '<iframe src=""></iframe>' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select an embed snippet to insert" });
    if (!picked) return;
    if (picked.label.includes("iframe") && !settings.security.allowIframes) {
      vscode.window.showErrorMessage("Quench: iframe embeds are disabled. Enable quench.security.allowIframes.");
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
    if (panel.active) this.lastActiveEditor = editor;

    let gotAnyWebviewMessage = false;
    const bootTimeout = setTimeout(() => {
      if (gotAnyWebviewMessage) return;
      vscode.window.showErrorMessage("Quench: No response from Webview (it may have failed to start).");
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

    // Set HTML first to start loading the Webview
    panel.webview.html = this.renderWebviewHtml(panel.webview);
    console.log("[quench] HTML set, sending INIT...");

    const settings = getQuenchSettings(document.uri);
    const settingsEffective = this.getEffectiveSettings(document.uri);
    const cssText = await this.computeCssTextForEditor(editor);
    panel.webview.postMessage({
      type: "INIT",
      documentUri: document.uri.toString(),
      text: document.getText(),
      version: document.version,
      themeKind: this.currentThemeKind,
      settings: settingsEffective,
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
        const cssText = await this.computeCssTextForEditor(editor);
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
      // No-op: resolveCustomTextEditor() waits for this.
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
        message: "Quench: REQUEST_SELECTION is an Extension → Webview message (not Webview → Extension)."
      } satisfies ExtensionToWebviewMessage);
      return;
    }

    if (msg.type === "SELECTION_RESULT") {
      // No-op: this is handled by requestSelectionFromWebview().
      return;
    }

    if (msg.type === "OPEN_LINK") {
      try {
        await openLink(editor.document.uri, msg.href);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Quench: Failed to open link: ${message}`);
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
            title: "Preview failed",
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
        vscode.window.showErrorMessage(`Quench: Failed to save attachment: ${message}`);
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
          throw new Error("Only files under the same workspace root can be referenced as relative links.");
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
  <body data-quench-theme-kind="${this.currentThemeKind}">
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

  private renderSettingsHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Quench Settings</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; padding: 16px; }
      h1 { margin: 0 0 8px; font-size: 18px; }
      .muted { opacity: 0.8; font-size: 12px; }
      .grid { display: grid; grid-template-columns: 220px 1fr; gap: 10px 16px; margin-top: 14px; }
      label { align-self: center; }
      input[type="text"], select { width: 100%; padding: 6px 8px; }
      .colorRow { display: flex; align-items: center; gap: 8px; }
	      .colorSwatch {
	        width: 18px;
	        height: 18px;
	        border-radius: 4px;
	        border: 1px solid rgba(127,127,127,0.6);
	        background: transparent;
	        cursor: pointer;
	        padding: 0;
	      }
	      .colorText { width: 220px; }
	      /* Keep it in-viewport so Chromium's color picker can open reliably. */
	      .colorPicker { position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; }
	      .row { display: flex; gap: 10px; margin-top: 14px; }
	      button { padding: 7px 10px; }
	      .status { margin-top: 10px; font-size: 12px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <h1>Quench Settings</h1>
    <div class="muted">
      Global settings file: <code id="filePath">(loading...)</code><br />
      These overrides take precedence over VS Code settings.<br />
      Theme overrides are applied after <code>quench.css.files</code>.
    </div>

    <div class="grid" style="margin-top: 18px;">
      <div><strong>Theme</strong></div><div></div>
      <label for="accentDark">Accent (dark)</label>
      <div class="colorRow">
        <button class="colorSwatch" id="accentDarkSwatch" aria-label="Pick color"></button>
        <input class="colorText" id="accentDark" type="text" placeholder="e.g. #7c3aed (empty = inherit)" />
        <input class="colorPicker" id="accentDarkPicker" type="color" />
      </div>
      <label for="accentLight">Accent (light)</label>
      <div class="colorRow">
        <button class="colorSwatch" id="accentLightSwatch" aria-label="Pick color"></button>
        <input class="colorText" id="accentLight" type="text" placeholder="e.g. #6d28d9 (empty = inherit)" />
        <input class="colorPicker" id="accentLightPicker" type="color" />
      </div>
      <label for="cursorDark">Cursor (dark)</label>
      <div class="colorRow">
        <button class="colorSwatch" id="cursorDarkSwatch" aria-label="Pick color"></button>
        <input class="colorText" id="cursorDark" type="text" placeholder="e.g. #ffffff (empty = inherit)" />
        <input class="colorPicker" id="cursorDarkPicker" type="color" />
      </div>
      <label for="cursorLight">Cursor (light)</label>
      <div class="colorRow">
        <button class="colorSwatch" id="cursorLightSwatch" aria-label="Pick color"></button>
        <input class="colorText" id="cursorLight" type="text" placeholder="e.g. #000000 (empty = inherit)" />
        <input class="colorPicker" id="cursorLightPicker" type="color" />
      </div>
      <label for="linkModHoverDark">Link Ctrl/⌘+Hover (dark)</label>
      <div class="colorRow">
        <button class="colorSwatch" id="linkModHoverDarkSwatch" aria-label="Pick color"></button>
        <input class="colorText" id="linkModHoverDark" type="text" placeholder="e.g. #7dd3fc (empty = inherit)" />
        <input class="colorPicker" id="linkModHoverDarkPicker" type="color" />
      </div>
      <label for="linkModHoverLight">Link Ctrl/⌘+Hover (light)</label>
      <div class="colorRow">
        <button class="colorSwatch" id="linkModHoverLightSwatch" aria-label="Pick color"></button>
        <input class="colorText" id="linkModHoverLight" type="text" placeholder="e.g. #0284c7 (empty = inherit)" />
        <input class="colorPicker" id="linkModHoverLightPicker" type="color" />
      </div>

      <div><strong>Editor</strong></div><div></div>
      <label for="lineWrapping">Line wrapping</label>
      <select id="lineWrapping">
        <option value="">Inherit</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>

      <div><strong>Preview</strong></div><div></div>
      <label for="syntaxVisibility">Syntax visibility</label>
      <select id="syntaxVisibility">
        <option value="">Inherit</option>
        <option value="smart">Smart</option>
        <option value="always">Always</option>
        <option value="minimal">Minimal</option>
      </select>

      <div><strong>Links</strong></div><div></div>
      <label for="previewOnHover">Preview on hover</label>
      <select id="previewOnHover">
        <option value="">Inherit</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>

      <div><strong>Keybindings</strong></div><div></div>
      <div class="muted" style="grid-column: 1 / -1;">
        These keybindings apply only inside Quench (webview). Use CodeMirror key names (e.g. <code>Mod-b</code>, <code>Shift-Mod-l</code>).<br />
        Empty = inherit Quench defaults. Check "Disable" to remove a default binding.
      </div>
      <label for="kb_toggleHeading1">Heading H1</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleHeading1" type="text" placeholder="e.g. Mod-1" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleHeading1" /> Disable
        </label>
      </div>
      <label for="kb_toggleHeading2">Heading H2</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleHeading2" type="text" placeholder="e.g. Mod-2" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleHeading2" /> Disable
        </label>
      </div>
      <label for="kb_toggleHeading3">Heading H3</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleHeading3" type="text" placeholder="e.g. Mod-3" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleHeading3" /> Disable
        </label>
      </div>
      <label for="kb_toggleHeading4">Heading H4</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleHeading4" type="text" placeholder="e.g. Mod-4" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleHeading4" /> Disable
        </label>
      </div>
      <label for="kb_toggleHeading5">Heading H5</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleHeading5" type="text" placeholder="e.g. Mod-5" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleHeading5" /> Disable
        </label>
      </div>
      <label for="kb_toggleHeading6">Heading H6</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleHeading6" type="text" placeholder="e.g. Mod-6" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleHeading6" /> Disable
        </label>
      </div>
      <label for="kb_toggleBullets">Toggle bullets</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleBullets" type="text" placeholder="e.g. Mod-'" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleBullets" /> Disable
        </label>
      </div>
      <label for="kb_toggleCheckboxes">Toggle checkboxes</label>
      <div class="colorRow">
        <input class="colorText" id="kb_toggleCheckboxes" type="text" placeholder="e.g. Mod-l, Shift-Mod-'" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_toggleCheckboxes" /> Disable
        </label>
      </div>
      <label for="kb_selectNextOccurrence">Add selection to next match</label>
      <div class="colorRow">
        <input class="colorText" id="kb_selectNextOccurrence" type="text" placeholder="e.g. Mod-d" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_selectNextOccurrence" /> Disable
        </label>
      </div>
      <label for="kb_selectAllOccurrences">Select all matches</label>
      <div class="colorRow">
        <input class="colorText" id="kb_selectAllOccurrences" type="text" placeholder="e.g. Shift-Mod-l" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_selectAllOccurrences" /> Disable
        </label>
      </div>
      <label for="kb_moveWordLeft">Move word left</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveWordLeft" type="text" placeholder="e.g. Mod-ArrowLeft" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveWordLeft" /> Disable
        </label>
      </div>
      <label for="kb_moveWordLeftSelect">Select word left</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveWordLeftSelect" type="text" placeholder="e.g. Shift-Mod-ArrowLeft" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveWordLeftSelect" /> Disable
        </label>
      </div>
      <label for="kb_moveWordRight">Move word right</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveWordRight" type="text" placeholder="e.g. Mod-ArrowRight" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveWordRight" /> Disable
        </label>
      </div>
      <label for="kb_moveWordRightSelect">Select word right</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveWordRightSelect" type="text" placeholder="e.g. Shift-Mod-ArrowRight" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveWordRightSelect" /> Disable
        </label>
      </div>
      <label for="kb_moveLineStart">Move to line start</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveLineStart" type="text" placeholder="e.g. Alt-ArrowLeft" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveLineStart" /> Disable
        </label>
      </div>
      <label for="kb_moveLineStartSelect">Select to line start</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveLineStartSelect" type="text" placeholder="e.g. Shift-Alt-ArrowLeft" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveLineStartSelect" /> Disable
        </label>
      </div>
      <label for="kb_moveLineEnd">Move to line end</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveLineEnd" type="text" placeholder="e.g. Alt-ArrowRight" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveLineEnd" /> Disable
        </label>
      </div>
      <label for="kb_moveLineEndSelect">Select to line end</label>
      <div class="colorRow">
        <input class="colorText" id="kb_moveLineEndSelect" type="text" placeholder="e.g. Shift-Alt-ArrowRight" />
        <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
          <input type="checkbox" id="kb_disable_moveLineEndSelect" /> Disable
        </label>
      </div>

      <div><strong>Security</strong></div><div></div>
      <label for="allowExternalImages">Allow external images</label>
      <select id="allowExternalImages">
        <option value="">Inherit</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
      <label for="allowHtmlEmbeds">Allow HTML embeds</label>
      <select id="allowHtmlEmbeds">
        <option value="">Inherit</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
      <label for="allowIframes">Allow iframes</label>
      <select id="allowIframes">
        <option value="">Inherit</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </div>

    <div class="row">
      <button id="save">Save</button>
      <button id="reload">Reload</button>
    </div>
    <div class="status" id="status"></div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      const el = (id) => document.getElementById(id);
      const status = el("status");
      const filePath = el("filePath");

      function setStatus(text) { status.textContent = text; }
      function v(id) { return el(id).value.trim(); }
      function setV(id, value) { el(id).value = value ?? ""; }

      function normalizeHexColor(input) {
        const s = (input || "").trim();
        if (!s) return "";
        // Support: #rgb, #rrggbb
        if (/^#[0-9a-fA-F]{3}$/.test(s)) {
          return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        }
        if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
        return "";
      }

      function syncColorControl(name) {
        const textEl = el(name);
        const swatchEl = el(name + "Swatch");
        const pickerEl = el(name + "Picker");
        const normalized = normalizeHexColor(textEl.value);
        if (normalized) {
          swatchEl.style.background = normalized;
          pickerEl.value = normalized;
        } else {
          swatchEl.style.background = "transparent";
        }
      }

	      function bindColorControl(name) {
	        const textEl = el(name);
	        const swatchEl = el(name + "Swatch");
	        const pickerEl = el(name + "Picker");
	
	        swatchEl.addEventListener("click", () => {
	          const normalized = normalizeHexColor(textEl.value) || "#000000";
	          pickerEl.value = normalized;
	          // Prefer showPicker() when available (Chromium), otherwise fall back to click().
	          const anyEl = pickerEl;
	          if (anyEl && typeof anyEl.showPicker === "function") anyEl.showPicker();
	          else pickerEl.click();
	        });
	        pickerEl.addEventListener("input", () => {
	          textEl.value = pickerEl.value;
	          syncColorControl(name);
        });
        textEl.addEventListener("input", () => syncColorControl(name));
      }

	      function setTri(id, value) {
	        if (typeof value === "boolean") el(id).value = value ? "true" : "false";
	        else el(id).value = "";
	      }

	      const KB_ACTIONS = [
	        "toggleHeading1",
	        "toggleHeading2",
	        "toggleHeading3",
	        "toggleHeading4",
	        "toggleHeading5",
	        "toggleHeading6",
	        "toggleBullets",
	        "toggleCheckboxes",
	        "selectNextOccurrence",
	        "selectAllOccurrences",
	        "moveWordLeft",
	        "moveWordLeftSelect",
	        "moveWordRight",
	        "moveWordRightSelect",
	        "moveLineStart",
	        "moveLineStartSelect",
	        "moveLineEnd",
	        "moveLineEndSelect"
	      ];

	      function parseKeys(s) {
	        const raw = (s || "").trim();
	        if (!raw) return [];
	        return raw
	          .split(",")
	          .map((x) => x.trim())
	          .filter((x) => x.length > 0);
	      }

	      function isKbInputId(id) {
	        return typeof id === "string" && id.startsWith("kb_") && !id.startsWith("kb_disable_");
	      }

	      function toCodeMirrorKey(e) {
	        const mods = [];
	        // CodeMirror's "Mod" maps to Cmd on macOS, Ctrl on others.
	        if (e.metaKey || e.ctrlKey) mods.push("Mod");
	        if (e.shiftKey) mods.push("Shift");
	        if (e.altKey) mods.push("Alt");

	        const key = e.key;
	        const code = e.code;

	        // Ignore pure modifier presses.
	        if (key === "Shift" || key === "Control" || key === "Meta" || key === "Alt") return null;

	        // Normalize special keys
	        const special = {
	          ArrowLeft: "ArrowLeft",
	          ArrowRight: "ArrowRight",
	          ArrowUp: "ArrowUp",
	          ArrowDown: "ArrowDown",
	          Enter: "Enter",
	          Escape: "Escape",
	          Backspace: "Backspace",
	          Delete: "Delete",
	          Tab: "Tab",
	          Home: "Home",
	          End: "End",
	          PageUp: "PageUp",
	          PageDown: "PageDown",
	          Spacebar: "Space",
	          " ": "Space"
	        };
	        if (special[key]) return mods.concat([special[key]]).join("-");

	        // For punctuation, e.key can be "Dead" depending on IME/layout; use e.code mapping then.
		        const codeMap = {
		          Quote: "'",
		          Backquote: "\`",
		          Minus: "-",
		          Equal: "=",
	          BracketLeft: "[",
	          BracketRight: "]",
	          Backslash: "\\\\",
	          Semicolon: ";",
	          Comma: ",",
	          Period: ".",
	          Slash: "/"
	        };

	        let base = key;
	        if (base === "Dead" && codeMap[code]) base = codeMap[code];
	        if (codeMap[code] && (base === undefined || base === "Dead")) base = codeMap[code];

	        // Letters should be lower-case in CodeMirror key names (e.g. Mod-l)
	        if (typeof base === "string" && base.length === 1 && /[A-Za-z]/.test(base)) base = base.toLowerCase();

	        // Digits are ok as-is.
	        if (!base || typeof base !== "string") return null;

	        // If no modifier and base is a printable character, don't capture (allow manual typing).
	        if (mods.length === 0 && base.length === 1 && base !== "Space") return null;

	        return mods.concat([base]).join("-");
	      }

	      function attachKeyCapture() {
	        document.addEventListener(
	          "keydown",
	          (e) => {
	            const t = e.target;
	            if (!(t instanceof HTMLInputElement)) return;
	            if (!isKbInputId(t.id)) return;

	            // Allow tab navigation.
	            if (e.key === "Tab") return;

	            const cmKey = toCodeMirrorKey(e);
	            if (!cmKey) return;

	            e.preventDefault();
	            e.stopPropagation();
	            t.value = cmKey;
	            const actionId = t.id.slice("kb_".length);
	            const disableEl = el("kb_disable_" + actionId);
	            if (disableEl instanceof HTMLInputElement) disableEl.checked = false;
	          },
	          true
	        );
	      }

	      function buildOverrides() {
	        const overrides = {};
	        const theme = {};
	        if (v("accentDark")) theme.accentDark = v("accentDark");
	        if (v("accentLight")) theme.accentLight = v("accentLight");
	        if (v("cursorDark")) theme.cursorDark = v("cursorDark");
	        if (v("cursorLight")) theme.cursorLight = v("cursorLight");
	        if (v("linkModHoverDark")) theme.linkModHoverDark = v("linkModHoverDark");
	        if (v("linkModHoverLight")) theme.linkModHoverLight = v("linkModHoverLight");
	        if (Object.keys(theme).length) overrides.theme = theme;

        const editor = {};
        if (v("lineWrapping") === "true") editor.lineWrapping = true;
        if (v("lineWrapping") === "false") editor.lineWrapping = false;
        if (Object.keys(editor).length) overrides.editor = editor;

        const preview = {};
        if (v("syntaxVisibility")) preview.syntaxVisibility = v("syntaxVisibility");
        if (Object.keys(preview).length) overrides.preview = preview;

        const links = {};
        if (v("previewOnHover") === "true") links.previewOnHover = true;
        if (v("previewOnHover") === "false") links.previewOnHover = false;
        if (Object.keys(links).length) overrides.links = links;

        const security = {};
        for (const key of ["allowExternalImages", "allowHtmlEmbeds", "allowIframes"]) {
          const val = v(key);
          if (val === "true") security[key] = true;
          if (val === "false") security[key] = false;
        }
	        if (Object.keys(security).length) overrides.security = security;

	        const keybindings = {};
	        for (const actionId of KB_ACTIONS) {
	          const disable = el("kb_disable_" + actionId).checked;
	          if (disable) {
	            keybindings[actionId] = [];
	            continue;
	          }
	          const keys = parseKeys(v("kb_" + actionId));
	          if (keys.length > 0) keybindings[actionId] = keys;
	        }
	        if (Object.keys(keybindings).length) overrides.keybindings = keybindings;

	        return overrides;
	      }

	      function applyKeybindingsOverrides(o) {
	        const kb = (o && o.keybindings) || {};
	        for (const actionId of KB_ACTIONS) {
	          const keys = kb[actionId];
	          if (Array.isArray(keys) && keys.length === 0) {
	            el("kb_disable_" + actionId).checked = true;
	            setV("kb_" + actionId, "");
	          } else {
	            el("kb_disable_" + actionId).checked = false;
	            setV("kb_" + actionId, Array.isArray(keys) ? keys.join(", ") : "");
	          }
	        }
	      }

      window.addEventListener("message", (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg.type !== "string") return;
	        if (msg.type === "SETTINGS_UI_INIT") {
          filePath.textContent = msg.filePath || "(unknown)";
          const eff = msg.effective || {};
          const s = eff.settings || {};
          const t = eff.theme || {};

	          // Fill with current effective values (includes defaults and VS Code settings)
	          setV("accentDark", t.accentDark);
	          setV("accentLight", t.accentLight);
	          setV("cursorDark", t.cursorDark);
	          setV("cursorLight", t.cursorLight);
	          setV("linkModHoverDark", t.linkModHoverDark);
	          setV("linkModHoverLight", t.linkModHoverLight);
	          syncColorControl("accentDark");
	          syncColorControl("accentLight");
	          syncColorControl("cursorDark");
	          syncColorControl("cursorLight");
	          syncColorControl("linkModHoverDark");
	          syncColorControl("linkModHoverLight");

          setTri("lineWrapping", s.editor && s.editor.lineWrapping);
          setV("syntaxVisibility", s.syntaxVisibility || "");
          setTri("previewOnHover", s.previewOnHover);
	          setTri("allowExternalImages", s.security && s.security.allowExternalImages);
	          setTri("allowHtmlEmbeds", s.security && s.security.allowHtmlEmbeds);
	          setTri("allowIframes", s.security && s.security.allowIframes);

	          // Fill from overrides (not effective), so "empty = inherit default" behavior is clear.
	          applyKeybindingsOverrides(msg.overrides || {});
	          setStatus("");
	        }
        if (msg.type === "SAVE_OK") {
          setStatus("Saved.");
        }
        if (msg.type === "SAVE_ERROR") {
          setStatus("Save failed: " + (msg.message || "unknown"));
        }
      });

      el("save").addEventListener("click", () => {
        setStatus("Saving...");
        vscode.postMessage({ type: "SAVE_GLOBAL_SETTINGS", overrides: buildOverrides() });
      });
      el("reload").addEventListener("click", () => {
        vscode.postMessage({ type: "SETTINGS_UI_READY" });
      });

	      bindColorControl("accentDark");
	      bindColorControl("accentLight");
	      bindColorControl("cursorDark");
	      bindColorControl("cursorLight");
	      bindColorControl("linkModHoverDark");
	      bindColorControl("linkModHoverLight");
	      attachKeyCapture();

	      vscode.postMessage({ type: "SETTINGS_UI_READY" });
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
    // Prefer the Custom Editor (commands are designed to work inside Quench)
    const active = this.lastActiveEditor;
    if (active) {
      const selection = await this.requestSelectionFromWebview(active);
      if (!selection) return null;
      const noteDir = active.document.uri.with({ path: path.posix.dirname(active.document.uri.path) });
      return { document: active.document, noteDir, selection };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("Quench: No target editor found.");
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
      vscode.window.showErrorMessage("Quench: The document changed or there are pending edits. Resyncing.");
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
    if (!ok) throw new Error("Failed to apply WorkspaceEdit");
  }
}

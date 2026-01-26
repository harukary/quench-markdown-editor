import * as vscode from "vscode";
import { ExtensionToWebviewMessage } from "../../shared/protocol";
import { getQuenchSettings } from "./Settings";

export class CssService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cssUpdatedEmitter = new vscode.EventEmitter<void>();
  readonly onDidCssUpdated = this.cssUpdatedEmitter.event;
  private readonly cssUris = new Set<string>();
  private readonly watcherDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.rebuildWatchers();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
        if (!folder) return;
        if (
          e.affectsConfiguration("quench.css.files", folder.uri) ||
          e.affectsConfiguration("quench.css.reloadOnSave", folder.uri)
        ) {
          this.rebuildWatchers();
          this.cssUpdatedEmitter.fire();
        }
      })
    );
  }

  onCssUpdated(listener: () => unknown): vscode.Disposable {
    return this.onDidCssUpdated(listener);
  }

  async readAllCssText(): Promise<string[]> {
    const settings = getQuenchSettings();
    const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
    if (!folder) return [];

    const out: string[] = [];
    for (const relPathRaw of settings.cssFiles) {
      const validated = validateWorkspaceRelativePath(relPathRaw);
      if (!validated.ok) {
        this.panel.webview.postMessage({
          type: "ERROR",
          message: `quench.css.files only supports workspace-relative paths: ${relPathRaw} (${validated.reason})`
        } satisfies ExtensionToWebviewMessage);
        continue;
      }
      try {
        const uri = vscode.Uri.joinPath(folder.uri, validated.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        out.push(Buffer.from(bytes).toString("utf8"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Quench: CSS read failed (${validated.path}): ${message}`);
        this.panel.webview.postMessage({
          type: "ERROR",
          message: `CSS read failed: ${validated.path}`,
          detail: message
        } satisfies ExtensionToWebviewMessage);
      }
    }
    return out;
  }

  dispose(): void {
    this.watcherDisposables.forEach((d) => d.dispose());
    this.watcherDisposables.length = 0;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.cssUpdatedEmitter.dispose();
  }

  private rebuildWatchers(): void {
    this.watcherDisposables.forEach((d) => d.dispose());
    this.watcherDisposables.length = 0;
    this.cssUris.clear();

    const settings = getQuenchSettings(this.document.uri);
    const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
    if (!folder) return;

    for (const relPathRaw of settings.cssFiles) {
      const validated = validateWorkspaceRelativePath(relPathRaw);
      if (!validated.ok) {
        vscode.window.showErrorMessage(
          `Quench: quench.css.files only supports workspace-relative paths: ${relPathRaw} (${validated.reason})`
        );
        continue;
      }

      const relPath = validated.path;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, relPath));
      this.watcherDisposables.push(watcher);
      this.cssUris.add(vscode.Uri.joinPath(folder.uri, relPath).toString());

      const fire = () => this.cssUpdatedEmitter.fire();
      watcher.onDidChange(fire, null, this.watcherDisposables);
      watcher.onDidCreate(fire, null, this.watcherDisposables);
      watcher.onDidDelete(fire, null, this.watcherDisposables);
    }

    if (settings.cssReloadOnSave) {
      const saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId !== "css") return;
        if (!this.cssUris.has(doc.uri.toString())) return;
        this.cssUpdatedEmitter.fire();
      });
      this.watcherDisposables.push(saveDisposable);
    }
  }
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

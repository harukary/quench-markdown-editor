import * as vscode from "vscode";

export class WorkspaceIndex implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly mdFilesByFolder = new Map<string, Set<string>>();

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.md");
    this.disposables.push(watcher);
    watcher.onDidCreate((uri) => this.add(uri), null, this.disposables);
    watcher.onDidDelete((uri) => this.remove(uri), null, this.disposables);
  }

  async rebuild(): Promise<void> {
    this.mdFilesByFolder.clear();
    const files = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
    for (const uri of files) this.add(uri);
  }

  getMarkdownFiles(folder?: vscode.WorkspaceFolder): vscode.Uri[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const targets = folder ? [folder] : folders;
    const out: vscode.Uri[] = [];
    for (const f of targets) {
      const set = this.mdFilesByFolder.get(f.uri.toString());
      if (!set) continue;
      for (const s of set) out.push(vscode.Uri.parse(s));
    }
    return out;
  }

  private add(uri: vscode.Uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const key = folder.uri.toString();
    const set = this.mdFilesByFolder.get(key) ?? new Set<string>();
    set.add(uri.toString());
    this.mdFilesByFolder.set(key, set);
  }

  private remove(uri: vscode.Uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const key = folder.uri.toString();
    const set = this.mdFilesByFolder.get(key);
    if (!set) return;
    set.delete(uri.toString());
    if (set.size === 0) this.mdFilesByFolder.delete(key);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}


import * as vscode from "vscode";
import { QuenchSettings } from "../../shared/protocol";

export type QuenchGlobalOverrides = {
  keybindings?: Record<string, string[]>;
  theme?: {
    accentDark?: string;
    accentLight?: string;
    cursorDark?: string;
    cursorLight?: string;
    linkModHoverDark?: string;
    linkModHoverLight?: string;
  };
  editor?: {
    lineWrapping?: boolean;
  };
  preview?: {
    syntaxVisibility?: QuenchSettings["syntaxVisibility"];
  };
  links?: {
    previewOnHover?: boolean;
  };
  security?: {
    allowExternalImages?: boolean;
    allowHtmlEmbeds?: boolean;
    allowIframes?: boolean;
  };
};

type GlobalSettingsFile = {
  version: 1;
  overrides: QuenchGlobalOverrides;
};

export class GlobalSettingsService implements vscode.Disposable {
  static readonly filename = "quench-settings.json";

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.context.globalStorageUri, GlobalSettingsService.filename)
    );

    const fire = () => this.onDidChangeEmitter.fire();
    this.watcher.onDidChange(fire);
    this.watcher.onDidCreate(fire);
    this.watcher.onDidDelete(fire);
  }

  dispose() {
    this.watcher?.dispose();
    this.watcher = null;
    this.onDidChangeEmitter.dispose();
  }

  getFileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, GlobalSettingsService.filename);
  }

  async readOverrides(): Promise<QuenchGlobalOverrides | null> {
    const uri = this.getFileUri();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw);
      return validateGlobalSettingsFile(parsed).overrides;
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") return null;
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Quench: Failed to read global settings: ${message}`);
      return null;
    }
  }

  async writeOverrides(overrides: QuenchGlobalOverrides): Promise<void> {
    const uri = this.getFileUri();
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      const file: GlobalSettingsFile = { version: 1, overrides };
      const json = JSON.stringify(file, null, 2) + "\n";
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Quench: Failed to write global settings: ${message}`);
      throw err;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateGlobalSettingsFile(value: unknown): GlobalSettingsFile {
  if (!isRecord(value)) throw new Error("Invalid global settings JSON (not an object).");
  if (value.version !== 1) throw new Error("Invalid global settings JSON (unsupported version).");
  const overridesRaw = value.overrides;
  if (!isRecord(overridesRaw)) throw new Error("Invalid global settings JSON (overrides must be an object).");

  const overrides: QuenchGlobalOverrides = {};

  if (isRecord(overridesRaw.keybindings)) {
    const kbRaw = overridesRaw.keybindings;
    const keybindings: Record<string, string[]> = {};
    for (const [actionId, keys] of Object.entries(kbRaw)) {
      if (!isStringArray(keys)) throw new Error(`Invalid global settings JSON (keybindings.${actionId} must be string[]).`);
      keybindings[actionId] = keys;
    }
    overrides.keybindings = keybindings;
  }

  if (isRecord(overridesRaw.theme)) {
    const t = overridesRaw.theme;
    const theme: QuenchGlobalOverrides["theme"] = {};
    if (isString(t.accentDark)) theme.accentDark = t.accentDark;
    if (isString(t.accentLight)) theme.accentLight = t.accentLight;
    if (isString(t.cursorDark)) theme.cursorDark = t.cursorDark;
    if (isString(t.cursorLight)) theme.cursorLight = t.cursorLight;
    if (isString(t.linkModHoverDark)) theme.linkModHoverDark = t.linkModHoverDark;
    if (isString(t.linkModHoverLight)) theme.linkModHoverLight = t.linkModHoverLight;
    if (Object.keys(theme).length > 0) overrides.theme = theme;
  }

  if (isRecord(overridesRaw.editor)) {
    const e = overridesRaw.editor;
    const editor: QuenchGlobalOverrides["editor"] = {};
    if (isBoolean(e.lineWrapping)) editor.lineWrapping = e.lineWrapping;
    if (Object.keys(editor).length > 0) overrides.editor = editor;
  }

  if (isRecord(overridesRaw.preview)) {
    const p = overridesRaw.preview;
    const preview: QuenchGlobalOverrides["preview"] = {};
    if (isString(p.syntaxVisibility) && (p.syntaxVisibility === "smart" || p.syntaxVisibility === "always" || p.syntaxVisibility === "minimal")) {
      preview.syntaxVisibility = p.syntaxVisibility;
    }
    if (Object.keys(preview).length > 0) overrides.preview = preview;
  }

  if (isRecord(overridesRaw.links)) {
    const l = overridesRaw.links;
    const links: QuenchGlobalOverrides["links"] = {};
    if (isBoolean(l.previewOnHover)) links.previewOnHover = l.previewOnHover;
    if (Object.keys(links).length > 0) overrides.links = links;
  }

  if (isRecord(overridesRaw.security)) {
    const s = overridesRaw.security;
    const security: QuenchGlobalOverrides["security"] = {};
    if (isBoolean(s.allowExternalImages)) security.allowExternalImages = s.allowExternalImages;
    if (isBoolean(s.allowHtmlEmbeds)) security.allowHtmlEmbeds = s.allowHtmlEmbeds;
    if (isBoolean(s.allowIframes)) security.allowIframes = s.allowIframes;
    if (Object.keys(security).length > 0) overrides.security = security;
  }

  return { version: 1, overrides };
}

export type QuenchSettings = {
  cssFiles: string[];
  cssReloadOnSave: boolean;
  editor: {
    lineWrapping: boolean;
  };
  /**
   * Quench (webview) keybindings override.
   * Keys are CodeMirror key names (e.g. "Mod-b", "Shift-Mod-l").
   * - Omitted actionId: use Quench defaults
   * - Empty array: disable the action binding
   */
  keybindings?: Record<string, string[]>;
  syntaxVisibility: "smart" | "always" | "minimal";
  previewOnHover: boolean;
  slugStyle: "github";
  attachments: {
    location: "workspaceRoot" | "specifiedFolder" | "sameFolder" | "subfolder";
    folderPath: string;
    subfolderName: string;
    naming: "timestamp" | "noteNameTimestamp";
  };
  security: {
    allowExternalImages: boolean;
    allowHtmlEmbeds: boolean;
    allowIframes: boolean;
  };
};

export type QuenchThemeKind = "light" | "dark" | "high-contrast" | "high-contrast-light";

export type TextChange = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export type ExtensionToWebviewMessage =
  | {
      type: "INIT";
      documentUri: string;
      text: string;
      version: number;
      /**
       * Theme kind sent by the extension host.
       * Optional for backward compatibility with older extension builds.
       */
      themeKind?: QuenchThemeKind;
      settings: QuenchSettings;
      cssText: string[];
    }
  | {
      type: "THEME_CHANGED";
      themeKind: QuenchThemeKind;
    }
  | {
      type: "SETTINGS_UPDATED";
      settings: QuenchSettings;
    }
  | {
      type: "REQUEST_SELECTION";
      requestId: string;
    }
  | {
      type: "CSS_UPDATED";
      cssText: string[];
    }
  | {
      type: "DOC_PATCH";
      version: number;
      changes: TextChange[];
    }
  | {
      type: "DOC_RESYNC";
      text: string;
      version: number;
      reason: "version_mismatch" | "requested" | "external_change";
    }
  | {
      type: "APPLY_EDIT_RESULT";
      requestId: string;
      applied: boolean;
      version: number;
      error?: string;
    }
  | {
      type: "PREVIEW_RESULT";
      requestId: string;
      title: string;
      text: string;
    }
  | {
      type: "RESOURCE_URI_RESULT";
      requestId: string;
      ok: boolean;
      uri?: string;
      error?: string;
    }
  | {
      type: "CREATE_ATTACHMENT_RESULT";
      requestId: string;
      ok: boolean;
      error?: string;
    }
  | {
      type: "ERROR";
      message: string;
      detail?: string;
    };

export type WebviewToExtensionMessage =
  | {
      type: "WEBVIEW_READY";
    }
  | {
      type: "BOOT_ERROR";
      message: string;
      detail?: string;
    }
  | {
      type: "APPLY_EDIT";
      requestId: string;
      baseVersion: number;
      changes: TextChange[];
    }
  | {
      type: "REQUEST_DOC_RESYNC";
    }
  | {
      type: "OPEN_LINK";
      href: string;
      fromUri: string;
    }
  | {
      type: "REQUEST_PREVIEW";
      requestId: string;
      href: string;
      fromUri: string;
    }
  | {
      type: "REQUEST_SELECTION";
      requestId: string;
    }
  | {
      type: "SELECTION_RESULT";
      requestId: string;
      baseVersion: number;
      selectionFrom: number;
      selectionTo: number;
      selectedText: string;
    }
  | {
      type: "REQUEST_RESOURCE_URI";
      requestId: string;
      href: string;
      fromUri: string;
      kind: "image";
    }
  | {
      type: "CREATE_ATTACHMENT";
      requestId: string;
      baseVersion: number;
      fromUri: string;
      insertFrom: number;
      insertTo: number;
      bytes: Uint8Array;
      filenameHint?: string;
      mime?: string;
      kind: "image";
    }
  | {
      type: "INSERT_IMAGE_REFERENCE";
      requestId: string;
      baseVersion: number;
      fromUri: string;
      insertFrom: number;
      insertTo: number;
      targetUri: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
}
function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number") throw new Error(`Invalid ${label}`);
}
function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
}

function isTextChangeArray(value: unknown): value is TextChange[] {
  if (!Array.isArray(value)) return false;
  return value.every((c) => {
    if (!isRecord(c)) return false;
    return typeof c.rangeOffset === "number" && typeof c.rangeLength === "number" && typeof c.text === "string";
  });
}

export function assertWebviewToExtensionMessage(value: unknown): WebviewToExtensionMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid message: not an object with type");
  }

  if (value.type === "WEBVIEW_READY") {
    return { type: "WEBVIEW_READY" };
  }

  if (value.type === "BOOT_ERROR") {
    assertString(value.message, "BOOT_ERROR.message");
    if (typeof value.detail !== "undefined") assertString(value.detail, "BOOT_ERROR.detail");
    return { type: "BOOT_ERROR", message: value.message, detail: value.detail };
  }

  if (value.type === "REQUEST_DOC_RESYNC") {
    return { type: "REQUEST_DOC_RESYNC" };
  }

  if (value.type === "APPLY_EDIT") {
    assertString(value.requestId, "APPLY_EDIT.requestId");
    assertNumber(value.baseVersion, "APPLY_EDIT.baseVersion");
    if (!isTextChangeArray(value.changes)) throw new Error("Invalid APPLY_EDIT.changes");
    return { type: "APPLY_EDIT", requestId: value.requestId, baseVersion: value.baseVersion, changes: value.changes };
  }

  if (value.type === "OPEN_LINK") {
    assertString(value.href, "OPEN_LINK.href");
    assertString(value.fromUri, "OPEN_LINK.fromUri");
    return { type: "OPEN_LINK", href: value.href, fromUri: value.fromUri };
  }

  if (value.type === "REQUEST_PREVIEW") {
    assertString(value.requestId, "REQUEST_PREVIEW.requestId");
    assertString(value.href, "REQUEST_PREVIEW.href");
    assertString(value.fromUri, "REQUEST_PREVIEW.fromUri");
    return { type: "REQUEST_PREVIEW", requestId: value.requestId, href: value.href, fromUri: value.fromUri };
  }

  if (value.type === "REQUEST_SELECTION") {
    assertString(value.requestId, "REQUEST_SELECTION.requestId");
    return { type: "REQUEST_SELECTION", requestId: value.requestId };
  }

  if (value.type === "SELECTION_RESULT") {
    assertString(value.requestId, "SELECTION_RESULT.requestId");
    assertNumber(value.baseVersion, "SELECTION_RESULT.baseVersion");
    assertNumber(value.selectionFrom, "SELECTION_RESULT.selectionFrom");
    assertNumber(value.selectionTo, "SELECTION_RESULT.selectionTo");
    assertString(value.selectedText, "SELECTION_RESULT.selectedText");
    return {
      type: "SELECTION_RESULT",
      requestId: value.requestId,
      baseVersion: value.baseVersion,
      selectionFrom: value.selectionFrom,
      selectionTo: value.selectionTo,
      selectedText: value.selectedText
    };
  }

  if (value.type === "REQUEST_RESOURCE_URI") {
    assertString(value.requestId, "REQUEST_RESOURCE_URI.requestId");
    assertString(value.href, "REQUEST_RESOURCE_URI.href");
    assertString(value.fromUri, "REQUEST_RESOURCE_URI.fromUri");
    assertString(value.kind, "REQUEST_RESOURCE_URI.kind");
    if (value.kind !== "image") throw new Error("Invalid REQUEST_RESOURCE_URI.kind");
    return { type: "REQUEST_RESOURCE_URI", requestId: value.requestId, href: value.href, fromUri: value.fromUri, kind: "image" };
  }

  if (value.type === "CREATE_ATTACHMENT") {
    assertString(value.requestId, "CREATE_ATTACHMENT.requestId");
    assertNumber(value.baseVersion, "CREATE_ATTACHMENT.baseVersion");
    assertString(value.fromUri, "CREATE_ATTACHMENT.fromUri");
    assertNumber(value.insertFrom, "CREATE_ATTACHMENT.insertFrom");
    assertNumber(value.insertTo, "CREATE_ATTACHMENT.insertTo");
    assertString(value.kind, "CREATE_ATTACHMENT.kind");
    if (value.kind !== "image") throw new Error("Invalid CREATE_ATTACHMENT.kind");
    const filenameHint = value.filenameHint;
    if (filenameHint !== undefined) assertString(filenameHint, "CREATE_ATTACHMENT.filenameHint");
    const mime = value.mime;
    if (mime !== undefined) assertString(mime, "CREATE_ATTACHMENT.mime");
    const bytes = value.bytes;
    if (!(bytes instanceof Uint8Array)) throw new Error("Invalid CREATE_ATTACHMENT.bytes (Uint8Array required)");
    return {
      type: "CREATE_ATTACHMENT",
      requestId: value.requestId,
      baseVersion: value.baseVersion,
      fromUri: value.fromUri,
      insertFrom: value.insertFrom,
      insertTo: value.insertTo,
      bytes,
      filenameHint,
      mime,
      kind: "image"
    };
  }

  if (value.type === "INSERT_IMAGE_REFERENCE") {
    assertString(value.requestId, "INSERT_IMAGE_REFERENCE.requestId");
    assertNumber(value.baseVersion, "INSERT_IMAGE_REFERENCE.baseVersion");
    assertString(value.fromUri, "INSERT_IMAGE_REFERENCE.fromUri");
    assertNumber(value.insertFrom, "INSERT_IMAGE_REFERENCE.insertFrom");
    assertNumber(value.insertTo, "INSERT_IMAGE_REFERENCE.insertTo");
    assertString(value.targetUri, "INSERT_IMAGE_REFERENCE.targetUri");
    return {
      type: "INSERT_IMAGE_REFERENCE",
      requestId: value.requestId,
      baseVersion: value.baseVersion,
      fromUri: value.fromUri,
      insertFrom: value.insertFrom,
      insertTo: value.insertTo,
      targetUri: value.targetUri
    };
  }

  throw new Error(`Unknown message type: ${value.type}`);
}

export function assertExtensionToWebviewMessage(value: unknown): ExtensionToWebviewMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid message: not an object with type");
  }

  switch (value.type) {
    case "INIT": {
      assertString(value.documentUri, "INIT.documentUri");
      assertString(value.text, "INIT.text");
      assertNumber(value.version, "INIT.version");
      if (typeof value.themeKind !== "undefined") assertString(value.themeKind, "INIT.themeKind");
      if (!isRecord(value.settings)) throw new Error("Invalid INIT.settings");
      if (!Array.isArray(value.cssText) || !value.cssText.every((s) => typeof s === "string")) throw new Error("Invalid INIT.cssText");
      return value as ExtensionToWebviewMessage;
    }
    case "THEME_CHANGED": {
      assertString(value.themeKind, "THEME_CHANGED.themeKind");
      return value as ExtensionToWebviewMessage;
    }
    case "SETTINGS_UPDATED": {
      if (!isRecord(value.settings)) throw new Error("Invalid SETTINGS_UPDATED.settings");
      return value as ExtensionToWebviewMessage;
    }
    case "REQUEST_SELECTION": {
      assertString(value.requestId, "REQUEST_SELECTION.requestId");
      return value as ExtensionToWebviewMessage;
    }
    case "CSS_UPDATED": {
      if (!Array.isArray(value.cssText) || !value.cssText.every((s) => typeof s === "string")) throw new Error("Invalid CSS_UPDATED.cssText");
      return value as ExtensionToWebviewMessage;
    }
    case "DOC_PATCH": {
      assertNumber(value.version, "DOC_PATCH.version");
      if (!isTextChangeArray(value.changes)) throw new Error("Invalid DOC_PATCH.changes");
      return value as ExtensionToWebviewMessage;
    }
    case "DOC_RESYNC": {
      assertString(value.text, "DOC_RESYNC.text");
      assertNumber(value.version, "DOC_RESYNC.version");
      assertString(value.reason, "DOC_RESYNC.reason");
      return value as ExtensionToWebviewMessage;
    }
    case "APPLY_EDIT_RESULT": {
      assertString(value.requestId, "APPLY_EDIT_RESULT.requestId");
      assertBoolean(value.applied, "APPLY_EDIT_RESULT.applied");
      assertNumber(value.version, "APPLY_EDIT_RESULT.version");
      const error = value.error;
      if (error !== undefined) assertString(error, "APPLY_EDIT_RESULT.error");
      return value as ExtensionToWebviewMessage;
    }
    case "PREVIEW_RESULT": {
      assertString(value.requestId, "PREVIEW_RESULT.requestId");
      assertString(value.title, "PREVIEW_RESULT.title");
      assertString(value.text, "PREVIEW_RESULT.text");
      return value as ExtensionToWebviewMessage;
    }
    case "RESOURCE_URI_RESULT": {
      assertString(value.requestId, "RESOURCE_URI_RESULT.requestId");
      assertBoolean(value.ok, "RESOURCE_URI_RESULT.ok");
      const uri = value.uri;
      const error = value.error;
      if (uri !== undefined) assertString(uri, "RESOURCE_URI_RESULT.uri");
      if (error !== undefined) assertString(error, "RESOURCE_URI_RESULT.error");
      return value as ExtensionToWebviewMessage;
    }
    case "CREATE_ATTACHMENT_RESULT": {
      assertString(value.requestId, "CREATE_ATTACHMENT_RESULT.requestId");
      assertBoolean(value.ok, "CREATE_ATTACHMENT_RESULT.ok");
      const error = value.error;
      if (error !== undefined) assertString(error, "CREATE_ATTACHMENT_RESULT.error");
      return value as ExtensionToWebviewMessage;
    }
    case "ERROR": {
      assertString(value.message, "ERROR.message");
      const detail = value.detail;
      if (detail !== undefined) assertString(detail, "ERROR.detail");
      return value as ExtensionToWebviewMessage;
    }
    default:
      throw new Error(`Unknown message type: ${value.type}`);
  }
}

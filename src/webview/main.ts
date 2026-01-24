import { EditorState, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import {
  assertExtensionToWebviewMessage,
  ExtensionToWebviewMessage,
  QuenchSettings,
  TextChange,
  WebviewToExtensionMessage
} from "../shared/protocol";

const vscode = acquireVsCodeApi();

const editorHost = document.getElementById("editor");
if (!editorHost) throw new Error("#editor not found");

const banner = document.getElementById("banner");
if (!banner) throw new Error("#banner not found");

const preview = document.getElementById("preview");
if (!preview) throw new Error("#preview not found");

const userCssEl = document.getElementById("quench-user-css");
if (!(userCssEl instanceof HTMLStyleElement)) throw new Error("#quench-user-css not found");

function post(msg: WebviewToExtensionMessage) {
  vscode.postMessage(msg);
}

function showBanner(text: string) {
  banner.textContent = text;
  banner.hidden = false;
}
function hideBanner() {
  banner.textContent = "";
  banner.hidden = true;
}

function applyCss(cssText: string[]) {
  userCssEl.textContent = cssText.join("\n\n");
}

let view: EditorView | null = null;
let settings: QuenchSettings | null = null;
let lastConfirmedVersion = 0;
const pendingRequestIds: string[] = [];
let nextRequestId = 1;
let isApplyingRemote = false;

const resolvedImageUriCache = new Map<string, string>();
const pendingResourceRequestIds = new Map<string, string>(); // requestId -> cacheKey

const forceRedrawEffect = StateEffect.define<void>();

function baseVersionForNextEdit(): number {
  return lastConfirmedVersion + pendingRequestIds.length;
}

function initEditor(text: string) {
  const state = EditorState.create({
    doc: text,
    extensions: [
      markdown(),
      livePreviewPlugin(),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        if (isApplyingRemote) return;

        const changes: TextChange[] = [];
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changes.push({
            rangeOffset: fromA,
            rangeLength: toA - fromA,
            text: inserted.toString()
          });
        });

        const requestId = String(nextRequestId++);
        pendingRequestIds.push(requestId);
        post({ type: "APPLY_EDIT", requestId, baseVersion: baseVersionForNextEdit() - 1, changes });
      })
    ]
  });

  if (view) view.destroy();
  view = new EditorView({ state, parent: editorHost });

  attachDomHandlers(view);
}

function applyDocPatch(message: { version: number; changes: TextChange[] }) {
  if (!view) throw new Error("Editor not initialized");

  if (pendingRequestIds.length > 0) {
    showBanner("外部変更を受信したため再同期します（未確定の入力は破棄されます）");
    pendingRequestIds.length = 0;
    post({ type: "REQUEST_DOC_RESYNC" });
    return;
  }

  const changes = [...message.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  isApplyingRemote = true;
  try {
    view.dispatch({
      changes: changes.map((c) => ({ from: c.rangeOffset, to: c.rangeOffset + c.rangeLength, insert: c.text }))
    });
    lastConfirmedVersion = message.version;
  } finally {
    isApplyingRemote = false;
  }
}

function handleApplyEditResult(message: { requestId: string; applied: boolean; version: number; error?: string }) {
  const expected = pendingRequestIds[0];
  if (!expected) {
    showBanner(`APPLY_EDIT_RESULT を受信しましたが pending がありません（requestId=${message.requestId}）`);
    return;
  }
  if (expected !== message.requestId) {
    showBanner(`APPLY_EDIT_RESULT の順序が不正です（expected=${expected}, got=${message.requestId}）`);
    pendingRequestIds.length = 0;
    post({ type: "REQUEST_DOC_RESYNC" });
    return;
  }
  pendingRequestIds.shift();

  if (!message.applied) {
    showBanner(`編集が適用されませんでした: ${message.error ?? "unknown"}`);
    pendingRequestIds.length = 0;
    post({ type: "REQUEST_DOC_RESYNC" });
    return;
  }

  lastConfirmedVersion = message.version;
  if (pendingRequestIds.length === 0) hideBanner();
}

function handleDocResync(message: { text: string; version: number; reason: string }) {
  pendingRequestIds.length = 0;
  lastConfirmedVersion = message.version;
  showBanner(`再同期しました（理由: ${message.reason}）。未確定の入力は破棄されました。`);
  initEditor(message.text);
}

function handleRequestSelection(requestId: string) {
  if (!view) throw new Error("Editor not initialized");
  if (pendingRequestIds.length > 0) {
    // コマンド実行前提の情報なので、未確定編集がある場合は「正しい状態」を返せない。
    showBanner("未確定の入力があります。少し待ってから再実行してください。");
  }

  const sel = view.state.selection.main;
  const selectedText = view.state.sliceDoc(sel.from, sel.to);
  post({
    type: "SELECTION_RESULT",
    requestId,
    baseVersion: baseVersionForNextEdit() - 0,
    selectionFrom: sel.from,
    selectionTo: sel.to,
    selectedText
  });
}

function showPreview(x: number, y: number, title: string, text: string) {
  preview.innerHTML = "";
  const titleEl = document.createElement("div");
  titleEl.className = "qm-preview-title";
  titleEl.textContent = title;
  const bodyEl = document.createElement("div");
  bodyEl.className = "qm-preview-body";
  bodyEl.textContent = text;
  preview.appendChild(titleEl);
  preview.appendChild(bodyEl);
  preview.hidden = false;

  const padding = 12;
  const maxLeft = window.innerWidth - (preview as HTMLElement).offsetWidth - padding;
  const maxTop = window.innerHeight - (preview as HTMLElement).offsetHeight - padding;
  (preview as HTMLElement).style.left = `${Math.max(padding, Math.min(x + padding, maxLeft))}px`;
  (preview as HTMLElement).style.top = `${Math.max(padding, Math.min(y + padding, maxTop))}px`;
}

function hidePreview() {
  preview.hidden = true;
  preview.innerHTML = "";
}

function requestResourceUri(kind: "image", href: string, fromUri: string): string | null {
  const cacheKey = `${fromUri}::${href}`;
  const hit = resolvedImageUriCache.get(cacheKey);
  if (hit) return hit;

  const requestId = `res_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  pendingResourceRequestIds.set(requestId, cacheKey);
  post({ type: "REQUEST_RESOURCE_URI", requestId, href, fromUri, kind });
  return null;
}

function livePreviewPlugin() {
  return ViewPlugin.fromClass(
    class {
      decorations: any;
      constructor(private readonly view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.transactions.some((t) => t.effects.some((e) => e.is(forceRedrawEffect)))
        ) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder: any[] = [];
        const mode = settings?.syntaxVisibility ?? "smart";
        const dimSyntax = (from: number, to: number) => {
          let cls = "qm-syntax";
          if (mode === "minimal") cls += " qm-syntax-dim";
          if (mode === "always") cls += "";
          if (mode === "smart") {
            const sel = view.state.selection.main;
            const overlaps = !(to <= sel.from || from >= sel.to);
            if (!overlaps) cls += " qm-syntax-dim";
          }
          builder.push(Decoration.mark({ class: cls }).range(from, to));
        };

        const addMark = (from: number, to: number, cls: string) => {
          builder.push(Decoration.mark({ class: cls }).range(from, to));
        };

        for (const r of view.visibleRanges) {
          let pos = r.from;
          while (pos <= r.to) {
            const line = view.state.doc.lineAt(pos);
            if (line.from >= r.to) break;
            const text = line.text;

            // 見出し（ATXのみ。Setextは表示上は通常テキストとして扱う）
            const m = /^(#{1,6})(\s+)(.*)$/.exec(text);
            if (m) {
              const hashes = m[1].length;
              dimSyntax(line.from, line.from + m[1].length);
              dimSyntax(line.from + m[1].length, line.from + m[1].length + m[2].length);
              addMark(line.from + m[1].length + m[2].length, line.to, `md-heading md-h${hashes}`);
            }
            // Setext（次の行が === / --- の場合）
            if (!m && line.number < view.state.doc.lines) {
              const next = view.state.doc.line(line.number + 1);
              const setext = /^(=+|-+)\s*$/.exec(next.text);
              if (setext && text.trim().length > 0) {
                const level = setext[1][0] === "=" ? 1 : 2;
                addMark(line.from, line.to, `md-heading md-h${level}`);
                dimSyntax(next.from, next.to);
              }
            }

            // インラインコード
            for (const match of text.matchAll(/`([^`]+)`/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const full = match[0];
              dimSyntax(line.from + start, line.from + start + 1);
              addMark(line.from + start + 1, line.from + start + full.length - 1, "md-inline-code");
              dimSyntax(line.from + start + full.length - 1, line.from + start + full.length);
            }

            // 太字（簡易）
            for (const match of text.matchAll(/\*\*([^\*]+)\*\*/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const full = match[0];
              dimSyntax(line.from + start, line.from + start + 2);
              addMark(line.from + start + 2, line.from + start + full.length - 2, "md-bold");
              dimSyntax(line.from + start + full.length - 2, line.from + start + full.length);
            }

            // 斜体（簡易）
            for (const match of text.matchAll(/(^|[^\*])\*([^\*]+)\*/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const prefixLen = match[1].length;
              const inner = match[2];
              const open = line.from + start + prefixLen;
              dimSyntax(open, open + 1);
              addMark(open + 1, open + 1 + inner.length, "md-italic");
              dimSyntax(open + 1 + inner.length, open + 1 + inner.length + 1);
            }

            // リンク/画像（簡易）
            for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const bang = match[1] === "!";
              const label = match[2] ?? "";
              const href = match[3] ?? "";
              const openBracket = line.from + start + (bang ? 1 : 0);
              if (bang) dimSyntax(line.from + start, line.from + start + 1);
              dimSyntax(openBracket, openBracket + 1);
              addMark(openBracket + 1, openBracket + 1 + label.length, "md-link");
              dimSyntax(openBracket + 1 + label.length, openBracket + 1 + label.length + 2); // ](
              addMark(openBracket + 1 + label.length + 2, openBracket + 1 + label.length + 2 + href.length, "md-link-destination");
              dimSyntax(
                openBracket + 1 + label.length + 2 + href.length,
                openBracket + 1 + label.length + 2 + href.length + 1
              ); // )

              if (bang && settings) {
                if (/^https?:\/\//i.test(href) && !settings.security.allowExternalImages) {
                  continue;
                }
                const cacheKey = `${documentUri}::${href}`;
                const resolved = resolvedImageUriCache.get(cacheKey) ?? null;
                if (!resolved) {
                  requestResourceUri("image", href, documentUri);
                }
                const widgetPos = openBracket + 1 + label.length + 2 + href.length + 1;
                builder.push(
                  Decoration.widget({
                    widget: new ImageWidget(resolved),
                    side: 1,
                    block: true
                  }).range(widgetPos)
                );
              }
            }

            pos = line.to + 1;
          }
        }

        return Decoration.set(builder, true);
      }
    },
    {
      decorations: (v) => v.decorations
    }
  );
}

class ImageWidget extends WidgetType {
  constructor(private readonly src: string | null) {
    super();
  }
  eq(other: ImageWidget) {
    return this.src === other.src;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "md-embed-image";
    if (!this.src) {
      const t = document.createElement("div");
      t.textContent = "画像を読み込み中…";
      t.style.opacity = "0.7";
      t.style.fontSize = "12px";
      wrap.appendChild(t);
      return wrap;
    }
    const img = document.createElement("img");
    img.src = this.src;
    img.style.maxWidth = "100%";
    img.style.borderRadius = "10px";
    img.loading = "lazy";
    wrap.appendChild(img);
    return wrap;
  }
}

let documentUri = "";
let hoverTimer: number | null = null;
let lastHoverHref: string | null = null;
let lastHoverPoint: { x: number; y: number } | null = null;
let pendingPreviewRequestId: string | null = null;

function attachDomHandlers(view: EditorView) {
  view.dom.addEventListener("click", (e) => {
    if (!(e instanceof MouseEvent)) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return;
    const href = findLinkHrefAt(view, pos);
    if (!href) return;
    e.preventDefault();
    post({ type: "OPEN_LINK", href, fromUri: documentUri });
  });

  view.dom.addEventListener("mousemove", (e) => {
    if (!(e instanceof MouseEvent)) return;
    if (!settings?.previewOnHover) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) {
      lastHoverHref = null;
      hidePreview();
      return;
    }
    const href = findLinkHrefAt(view, pos);
    if (!href) {
      lastHoverHref = null;
      hidePreview();
      return;
    }
    if (href === lastHoverHref) return;
    lastHoverHref = href;
    lastHoverPoint = { x: e.clientX, y: e.clientY };
    if (hoverTimer) window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      const requestId = `prev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      pendingPreviewRequestId = requestId;
      post({ type: "REQUEST_PREVIEW", requestId, href, fromUri: documentUri });
    }, 250);
  });

  view.dom.addEventListener("mouseleave", () => {
    lastHoverHref = null;
    pendingPreviewRequestId = null;
    hidePreview();
  });

  view.dom.addEventListener("paste", async (e) => {
    if (!(e instanceof ClipboardEvent)) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const items = [...dt.items];
    const imageItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sel = view.state.selection.main;
    const requestId = `att_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    showBanner("画像を添付として保存中…");
    post({
      type: "CREATE_ATTACHMENT",
      requestId,
      baseVersion: baseVersionForNextEdit(),
      fromUri: documentUri,
      insertFrom: sel.from,
      insertTo: sel.to,
      bytes,
      filenameHint: file.name,
      mime: file.type,
      kind: "image"
    });
  });

  view.dom.addEventListener("drop", async (e) => {
    if (!(e instanceof DragEvent)) return;
    if (!e.dataTransfer) return;

    const uriList = e.dataTransfer.getData("text/uri-list");
    if (uriList) {
      const first = uriList.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith("#"));
      if (first) {
        e.preventDefault();
        const sel = view.state.selection.main;
        const requestId = `ref_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        showBanner("参照リンクを挿入中…");
        post({
          type: "INSERT_IMAGE_REFERENCE",
          requestId,
          baseVersion: baseVersionForNextEdit(),
          fromUri: documentUri,
          insertFrom: sel.from,
          insertTo: sel.to,
          targetUri: first
        });
        return;
      }
    }

    const files = e.dataTransfer.files ? [...e.dataTransfer.files] : [];
    const file = files.find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sel = view.state.selection.main;
    const requestId = `att_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    showBanner("画像を添付として保存中…");
    post({
      type: "CREATE_ATTACHMENT",
      requestId,
      baseVersion: baseVersionForNextEdit(),
      fromUri: documentUri,
      insertFrom: sel.from,
      insertTo: sel.to,
      bytes,
      filenameHint: file.name,
      mime: file.type,
      kind: "image"
    });
  });

  view.dom.addEventListener("dragover", (e) => {
    if (!(e instanceof DragEvent)) return;
    e.preventDefault();
  });
}

function findLinkHrefAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const offsetInLine = pos - line.from;
  for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const full = match[0];
    const end = start + full.length;
    if (offsetInLine < start || offsetInLine > end) continue;
    const href = match[3] ?? "";
    return href.trim();
  }
  return null;
}

window.addEventListener("message", (event) => {
  let msg: ExtensionToWebviewMessage;
  try {
    msg = assertExtensionToWebviewMessage(event.data);
  } catch (e) {
    showBanner(e instanceof Error ? e.message : String(e));
    return;
  }

  switch (msg.type) {
    case "INIT": {
      settings = msg.settings;
      documentUri = msg.documentUri;
      lastConfirmedVersion = msg.version;
      applyCss(msg.cssText);
      initEditor(msg.text);
      hideBanner();
      break;
    }
    case "REQUEST_SELECTION": {
      handleRequestSelection(msg.requestId);
      break;
    }
    case "CSS_UPDATED": {
      applyCss(msg.cssText);
      break;
    }
    case "DOC_PATCH": {
      applyDocPatch(msg);
      break;
    }
    case "DOC_RESYNC": {
      handleDocResync(msg);
      break;
    }
    case "APPLY_EDIT_RESULT": {
      handleApplyEditResult(msg);
      break;
    }
    case "PREVIEW_RESULT": {
      if (!lastHoverPoint) break;
      if (pendingPreviewRequestId && msg.requestId !== pendingPreviewRequestId) break;
      showPreview(lastHoverPoint.x, lastHoverPoint.y, msg.title, msg.text);
      break;
    }
    case "RESOURCE_URI_RESULT": {
      const cacheKey = pendingResourceRequestIds.get(msg.requestId);
      if (!cacheKey) break;
      pendingResourceRequestIds.delete(msg.requestId);
      if (msg.ok && msg.uri) {
        resolvedImageUriCache.set(cacheKey, msg.uri);
        if (view) view.dispatch({ effects: forceRedrawEffect.of(undefined) });
      }
      break;
    }
    case "CREATE_ATTACHMENT_RESULT": {
      if (!msg.ok) {
        showBanner(`画像添付に失敗しました: ${msg.error ?? "unknown"}`);
      } else {
        hideBanner();
      }
      break;
    }
    case "ERROR": {
      showBanner(msg.detail ? `${msg.message}: ${msg.detail}` : msg.message);
      break;
    }
  }
});

// Extension側が INIT を送る前に message listener が張られていることを保証する。
post({ type: "WEBVIEW_READY" });

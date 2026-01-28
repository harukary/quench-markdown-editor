// VSCode webview API
declare function acquireVsCodeApi(): any;

import { EditorSelection, EditorState, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { keymap } from "@codemirror/view";
import {
  assertExtensionToWebviewMessage,
  ExtensionToWebviewMessage,
  QuenchSettings,
  TextChange,
  WebviewToExtensionMessage
} from "../shared/protocol";

const vscode = (window as any).__quench_vscode ?? acquireVsCodeApi();
console.log("[Quench] Script loaded, vscode API:", vscode ? "available" : "NOT AVAILABLE");

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

type ResolvedImageEntry =
  | { kind: "pending" }
  | { kind: "ok"; uri: string }
  | { kind: "error"; error: string };

const resolvedImageCache = new Map<string, ResolvedImageEntry>();
const pendingResourceRequestIds = new Map<string, string>(); // requestId -> cacheKey

const forceRedrawEffect = StateEffect.define<void>();
const lineWrappingCompartment = new Compartment();
const keybindingsCompartment = new Compartment();

type QuenchKeybindings = Record<string, string[]>;

const DEFAULT_KEYBINDINGS: QuenchKeybindings = {
  // Markdown shortcuts (user preference aligned)
  toggleHeading1: ["Mod-1"],
  toggleHeading2: ["Mod-2"],
  toggleHeading3: ["Mod-3"],
  toggleHeading4: ["Mod-4"],
  toggleHeading5: ["Mod-5"],
  toggleHeading6: ["Mod-6"],
  toggleBullets: ["Mod-'"],
  toggleCheckboxes: ["Mod-l", "Shift-Mod-'"],

  // Multi-cursor selection
  selectNextOccurrence: ["Mod-d"],
  selectAllOccurrences: ["Shift-Mod-l"],

  // Cursor movement (aligned with user's VS Code overrides)
  moveWordLeft: ["Mod-ArrowLeft"],
  moveWordLeftSelect: ["Shift-Mod-ArrowLeft"],
  moveWordRight: ["Mod-ArrowRight"],
  moveWordRightSelect: ["Shift-Mod-ArrowRight"],
  moveLineStart: ["Alt-ArrowLeft"],
  moveLineStartSelect: ["Shift-Alt-ArrowLeft"],
  moveLineEnd: ["Alt-ArrowRight"],
  moveLineEndSelect: ["Shift-Alt-ArrowRight"]
};

let keybindingHandlers: Record<string, (view: EditorView) => boolean> | null = null;

const setModifierHoverLinkEffect = StateEffect.define<{ from: number; to: number } | null>();
const modifierHoverLinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setModifierHoverLinkEffect)) {
        const payload = e.value;
        if (!payload) return Decoration.none;
        const from = Math.max(0, Math.min(tr.state.doc.length, payload.from));
        const to = Math.max(from, Math.min(tr.state.doc.length, payload.to));
        return Decoration.set([Decoration.mark({ class: "quench-mod-hover" }).range(from, to)]);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f)
});

type TableAlign = "left" | "center" | "right";

type ParsedGfmTable = {
  header: string[];
  aligns: TableAlign[];
  rows: string[][];
};

function splitGfmTableRow(line: string): string[] {
  // Minimal parser:
  // - supports escaping pipes with \|
  // - ignores pipes inside inline code spans delimited by single backticks
  // - trims cells, keeps inner whitespace
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);

  const out: string[] = [];
  let buf = "";
  let inCode = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      buf += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf.trim());
  return out;
}

function parseAlignCells(alignLineText: string): TableAlign[] | null {
  const raw = splitGfmTableRow(alignLineText).map((c) => c.replace(/\s+/g, ""));
  if (raw.length === 0) return null;
  const alignPattern = /^:?-{3,}:?$/;
  if (!raw.every((c) => alignPattern.test(c))) return null;
  return raw.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function parseGfmTable(doc: Text, range: ParsedTableRange): ParsedGfmTable | null {
  const headerLine = doc.line(range.headerLineNo);
  const alignLine = doc.line(range.alignLineNo);

  if (!headerLine.text.includes("|") || !alignLine.text.includes("|")) return null;
  const aligns = parseAlignCells(alignLine.text);
  if (!aligns) return null;

  const header = splitGfmTableRow(headerLine.text);
  const colCount = Math.max(header.length, aligns.length);

  const normRow = (cells: string[]): string[] => {
    const next = cells.slice(0, colCount);
    while (next.length < colCount) next.push("");
    return next;
  };

  const rows: string[][] = [];
  for (let ln = range.alignLineNo + 1; ln <= range.endLineNo; ln++) {
    const line = doc.line(ln);
    rows.push(normRow(splitGfmTableRow(line.text)));
  }

  const headerNorm = normRow(header);
  const alignsNorm = aligns.slice(0, colCount);
  while (alignsNorm.length < colCount) alignsNorm.push("left");

  return { header: headerNorm, aligns: alignsNorm, rows };
}

class TableWidget extends WidgetType {
  constructor(
    private readonly view: EditorView,
    private readonly tableFrom: number,
    private readonly table: ParsedGfmTable
  ) {
    super();
  }
  eq(other: TableWidget) {
    return JSON.stringify(this.table) === JSON.stringify(other.table);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "md-table-widget";
    wrap.addEventListener("click", (e) => {
      // Switch to "edit mode": place the caret inside the table so decorations stop hiding the raw Markdown.
      e.preventDefault();
      e.stopPropagation();
      try {
        this.view.focus();
        this.view.dispatch({
          selection: EditorSelection.single(Math.min(this.view.state.doc.length, this.tableFrom + 1)),
          scrollIntoView: true
        });
      } catch (err) {
        console.error("[Quench] Failed to enter table edit mode", err);
      }
    });

    const tableEl = document.createElement("table");
    tableEl.className = "md-table";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (let i = 0; i < this.table.header.length; i++) {
      const th = document.createElement("th");
      th.textContent = this.table.header[i] ?? "";
      th.dataset.align = this.table.aligns[i] ?? "left";
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    tableEl.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.table.rows) {
      const tr = document.createElement("tr");
      for (let i = 0; i < this.table.header.length; i++) {
        const td = document.createElement("td");
        td.textContent = row[i] ?? "";
        td.dataset.align = this.table.aligns[i] ?? "left";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);

    wrap.appendChild(tableEl);
    return wrap;
  }
}

function inferThemeKindFromDom(): string {
  const explicit = document.body.dataset.quenchThemeKind;
  if (explicit) return explicit;

  const vscodeKind = document.body.getAttribute("data-vscode-theme-kind") ?? document.body.dataset.vscodeThemeKind ?? "";
  switch (vscodeKind) {
    case "vscode-light":
      return "light";
    case "vscode-dark":
      return "dark";
    case "vscode-high-contrast":
      return "high-contrast";
    case "vscode-high-contrast-light":
      return "high-contrast-light";
    default:
      return "";
  }
}

function applyThemeKind(kind?: string) {
  const next = kind && kind.length > 0 ? kind : inferThemeKindFromDom();
  if (!next) return;
  document.body.dataset.quenchThemeKind = next;
}

function baseVersionForNextEdit(): number {
  return lastConfirmedVersion + pendingRequestIds.length;
}

function applySettings(next: QuenchSettings) {
  settings = next;
  if (!view) return;
  const enableWrap = Boolean(next.editor?.lineWrapping);
  view.dispatch({
    effects: lineWrappingCompartment.reconfigure(enableWrap ? EditorView.lineWrapping : [])
  });
  if (!keybindingHandlers) throw new Error("Keybinding handlers not initialized");
  view.dispatch({
    effects: keybindingsCompartment.reconfigure(buildKeymapExtension(next.keybindings, keybindingHandlers))
  });
  view.dispatch({ effects: forceRedrawEffect.of(undefined) });
}

function buildKeymapExtension(
  keybindings: QuenchSettings["keybindings"] | undefined,
  handlers: Record<string, (view: EditorView) => boolean>
) {
  const items: { key: string; run: (view: EditorView) => boolean; preventDefault: boolean }[] = [];
  for (const [actionId, run] of Object.entries(handlers)) {
    const override = keybindings?.[actionId];
    const keys = override !== undefined ? override : DEFAULT_KEYBINDINGS[actionId] ?? [];
    if (keys.length === 0) continue; // disabled
    for (const k of keys) {
      const key = (k ?? "").trim();
      if (!key) continue;
      items.push({ key, run, preventDefault: true });
    }
  }
  return keymap.of(items);
}

function initEditor(text: string) {
  const scanForwardToWord = (docText: string, pos: number): number | null => {
    for (let i = Math.max(0, pos); i < docText.length; i++) {
      if (/\w/.test(docText[i] ?? "")) return i;
    }
    return null;
  };

  const scanBackwardToWord = (docText: string, pos: number): number | null => {
    for (let i = Math.min(docText.length - 1, pos); i >= 0; i--) {
      if (/\w/.test(docText[i] ?? "")) return i;
    }
    return null;
  };

  const moveWord = (view: EditorView, dir: "left" | "right", select: boolean): boolean => {
    const docText = view.state.doc.toString();
    const ranges = view.state.selection.ranges.map((r) => {
      const head = r.head;
      let nextHead = head;
      if (dir === "right") {
        const w = view.state.wordAt(head);
        if (w && head < w.to) {
          nextHead = w.to;
        } else {
          const start = scanForwardToWord(docText, head + 1);
          if (start == null) nextHead = head;
          else {
            const w2 = view.state.wordAt(start);
            nextHead = w2 ? w2.to : start;
          }
        }
      } else {
        const w = view.state.wordAt(head);
        if (w && head > w.from) {
          nextHead = w.from;
        } else {
          const start = scanBackwardToWord(docText, head - 1);
          if (start == null) nextHead = head;
          else {
            const w2 = view.state.wordAt(start);
            nextHead = w2 ? w2.from : start;
          }
        }
      }

      if (!select) return EditorSelection.cursor(nextHead);
      return EditorSelection.range(r.anchor, nextHead);
    });
    view.dispatch({ selection: EditorSelection.create(ranges, view.state.selection.mainIndex), scrollIntoView: true });
    return true;
  };

  const moveLineEdge = (view: EditorView, edge: "start" | "end", select: boolean): boolean => {
    const ranges = view.state.selection.ranges.map((r) => {
      const line = view.state.doc.lineAt(r.head);
      const nextHead = edge === "start" ? line.from : line.to;
      if (!select) return EditorSelection.cursor(nextHead);
      return EditorSelection.range(r.anchor, nextHead);
    });
    view.dispatch({ selection: EditorSelection.create(ranges, view.state.selection.mainIndex), scrollIntoView: true });
    return true;
  };

  const selectWordAtCursor = (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (sel.from !== sel.to) return false;
    const word = view.state.wordAt(sel.from);
    if (!word) return false;
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) });
    return true;
  };

  const selectNextOccurrence = (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (sel.from === sel.to) return selectWordAtCursor(view);
    const query = view.state.sliceDoc(sel.from, sel.to);
    if (!query) return false;

    const docText = view.state.doc.toString();
    const searchFrom = sel.to;
    let idx = docText.indexOf(query, searchFrom);
    if (idx < 0) idx = docText.indexOf(query, 0);
    if (idx < 0) return false;

    const from = idx;
    const to = idx + query.length;
    const ranges = view.state.selection.ranges.map((r) => EditorSelection.range(r.from, r.to));
    ranges.push(EditorSelection.range(from, to));
    view.dispatch({
      selection: EditorSelection.create(ranges, ranges.length - 1),
      scrollIntoView: true
    });
    return true;
  };

  const selectAllOccurrences = (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (sel.from === sel.to) {
      const ok = selectWordAtCursor(view);
      if (!ok) return false;
      return selectAllOccurrences(view);
    }
    const query = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (!query) return false;

    const docText = view.state.doc.toString();
    const ranges: { from: number; to: number }[] = [];
    let idx = 0;
    while (idx <= docText.length) {
      const next = docText.indexOf(query, idx);
      if (next < 0) break;
      ranges.push({ from: next, to: next + query.length });
      idx = next + query.length;
    }
    if (ranges.length === 0) return false;

    let mainIndex = ranges.findIndex((r) => r.from === sel.from && r.to === sel.to);
    if (mainIndex < 0) mainIndex = 0;
    view.dispatch({
      selection: EditorSelection.create(
        ranges.map((r) => EditorSelection.range(r.from, r.to)),
        mainIndex
      ),
      scrollIntoView: true
    });
    return true;
  };

  const toggleCheckboxes = (view: EditorView): boolean => {
    const doc = view.state.doc;
    const targetLineNos = new Set<number>();
    for (const r of view.state.selection.ranges) {
      const fromLine = doc.lineAt(r.from).number;
      const toLine = doc.lineAt(r.to).number;
      for (let ln = fromLine; ln <= toLine; ln++) targetLineNos.add(ln);
    }
    if (targetLineNos.size === 0) return false;

    const changes: { from: number; to: number; insert: string }[] = [];
    const sortedLineNos = [...targetLineNos].sort((a, b) => b - a); // apply bottom-up
    for (const ln of sortedLineNos) {
      const line = doc.line(ln);
      const text = line.text;
      const m = /^(\s*)([-*+])(\s+)(\[(?: |x|X)\])(\s+)/.exec(text);
      if (m) {
        // Remove the checkbox marker to revert to a normal bullet.
        const indent = m[1] ?? "";
        const bullet = m[2] ?? "-";
        const spacesAfterBullet = m[3] ?? " ";
        const trailing = text.slice((m[0] ?? "").length);
        const next = `${indent}${bullet}${spacesAfterBullet}${trailing}`;
        changes.push({ from: line.from, to: line.to, insert: next });
        continue;
      }

      const b = /^(\s*)([-*+])(\s+)(.*)$/.exec(text);
      if (b) {
        const indent = b[1] ?? "";
        const bullet = b[2] ?? "-";
        const spacesAfterBullet = b[3] ?? " ";
        const rest = b[4] ?? "";
        const next = `${indent}${bullet}${spacesAfterBullet}[ ] ${rest}`;
        changes.push({ from: line.from, to: line.to, insert: next });
        continue;
      }

      // Not a list item: convert to a checkbox list item (Obsidian-like).
      const lead = /^(\s*)(.*)$/.exec(text);
      const indent = lead?.[1] ?? "";
      const rest = lead?.[2] ?? text;
      const next = `${indent}- [ ] ${rest}`;
      changes.push({ from: line.from, to: line.to, insert: next });
    }

    if (changes.length === 0) return false;
    view.dispatch({ changes });
    return true;
  };

  const toggleBullets = (view: EditorView): boolean => {
    const doc = view.state.doc;
    const targetLineNos = new Set<number>();
    for (const r of view.state.selection.ranges) {
      const fromLine = doc.lineAt(r.from).number;
      const toLine = doc.lineAt(r.to).number;
      for (let ln = fromLine; ln <= toLine; ln++) targetLineNos.add(ln);
    }
    if (targetLineNos.size === 0) return false;

    const changes: { from: number; to: number; insert: string }[] = [];
    const sortedLineNos = [...targetLineNos].sort((a, b) => b - a); // apply bottom-up
    for (const ln of sortedLineNos) {
      const line = doc.line(ln);
      const text = line.text;
      const m = /^(\s*)([-*+])(\s+)(?!\[[ xX]\])(.+)?$/.exec(text);
      if (m) {
        // Remove the bullet marker (keep the content).
        const indent = m[1] ?? "";
        const rest = m[4] ?? "";
        changes.push({ from: line.from, to: line.to, insert: `${indent}${rest}` });
        continue;
      }

      // Do not touch existing task list items here (handled by toggleCheckboxes).
      const task = /^(\s*)([-*+])(\s+)\[(?: |x|X)\](\s+)(.*)$/.exec(text);
      if (task) continue;

      const lead = /^(\s*)(.*)$/.exec(text);
      const indent = lead?.[1] ?? "";
      const rest = (lead?.[2] ?? text).trimStart();
      changes.push({ from: line.from, to: line.to, insert: `${indent}- ${rest}` });
    }

    if (changes.length === 0) return false;
    view.dispatch({ changes });
    return true;
  };

  const toggleHeadingLevel = (view: EditorView, level: 1 | 2 | 3 | 4 | 5 | 6): boolean => {
    const doc = view.state.doc;
    const targetLineNos = new Set<number>();
    for (const r of view.state.selection.ranges) {
      const fromLine = doc.lineAt(r.from).number;
      const toLine = doc.lineAt(r.to).number;
      for (let ln = fromLine; ln <= toLine; ln++) targetLineNos.add(ln);
    }
    if (targetLineNos.size === 0) return false;

    const changes: { from: number; to: number; insert: string }[] = [];
    const sortedLineNos = [...targetLineNos].sort((a, b) => b - a); // apply bottom-up
    for (const ln of sortedLineNos) {
      const line = doc.line(ln);
      const text = line.text;
      const m = /^(\s*)(#{1,6})\s+(.*)$/.exec(text);
      if (m) {
        const indent = m[1] ?? "";
        const hashes = m[2] ?? "";
        const rest = m[3] ?? "";
        const current = Math.min(6, Math.max(1, hashes.length));
        if (current === level) {
          changes.push({ from: line.from, to: line.to, insert: `${indent}${rest}` });
        } else {
          changes.push({ from: line.from, to: line.to, insert: `${indent}${"#".repeat(level)} ${rest}` });
        }
        continue;
      }

      const lead = /^(\s*)(.*)$/.exec(text);
      const indent = lead?.[1] ?? "";
      const rest = (lead?.[2] ?? text).trimStart();
      changes.push({ from: line.from, to: line.to, insert: `${indent}${"#".repeat(level)} ${rest}` });
    }

    if (changes.length === 0) return false;
    view.dispatch({ changes });
    return true;
  };

  const handlers: Record<string, (view: EditorView) => boolean> = {
    toggleHeading1: (v) => toggleHeadingLevel(v, 1),
    toggleHeading2: (v) => toggleHeadingLevel(v, 2),
    toggleHeading3: (v) => toggleHeadingLevel(v, 3),
    toggleHeading4: (v) => toggleHeadingLevel(v, 4),
    toggleHeading5: (v) => toggleHeadingLevel(v, 5),
    toggleHeading6: (v) => toggleHeadingLevel(v, 6),
    toggleBullets: (v) => toggleBullets(v),
    toggleCheckboxes: (v) => toggleCheckboxes(v),
    selectNextOccurrence: (v) => selectNextOccurrence(v),
    selectAllOccurrences: (v) => selectAllOccurrences(v),
    moveWordLeft: (v) => moveWord(v, "left", false),
    moveWordLeftSelect: (v) => moveWord(v, "left", true),
    moveWordRight: (v) => moveWord(v, "right", false),
    moveWordRightSelect: (v) => moveWord(v, "right", true),
    moveLineStart: (v) => moveLineEdge(v, "start", false),
    moveLineStartSelect: (v) => moveLineEdge(v, "start", true),
    moveLineEnd: (v) => moveLineEdge(v, "end", false),
    moveLineEndSelect: (v) => moveLineEdge(v, "end", true)
  };

  // Store handlers for later reconfigure (SETTINGS_UPDATED).
  keybindingHandlers = handlers;

  const state = EditorState.create({
    doc: text,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      lineWrappingCompartment.of(settings?.editor?.lineWrapping ? EditorView.lineWrapping : []),
      modifierHoverLinkField,
      keybindingsCompartment.of(buildKeymapExtension(settings?.keybindings, handlers)),
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
    showBanner("External change detected. Resyncing (pending input will be discarded).");
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
    showBanner(`Received APPLY_EDIT_RESULT but there is no pending request (requestId=${message.requestId}).`);
    return;
  }
  if (expected !== message.requestId) {
    showBanner(`Invalid APPLY_EDIT_RESULT order (expected=${expected}, got=${message.requestId}).`);
    pendingRequestIds.length = 0;
    post({ type: "REQUEST_DOC_RESYNC" });
    return;
  }
  pendingRequestIds.shift();

  if (!message.applied) {
    showBanner(`Edit was not applied: ${message.error ?? "unknown"}`);
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
  showBanner(`Resynced (reason: ${message.reason}). Pending input was discarded.`);
  initEditor(message.text);
}

function handleRequestSelection(requestId: string) {
  if (!view) throw new Error("Editor not initialized");
  if (pendingRequestIds.length > 0) {
    // This is used by commands; with pending edits we cannot return a correct state.
    showBanner("There are pending edits. Please wait a moment and try again.");
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
  const hit = resolvedImageCache.get(cacheKey);
  if (hit?.kind === "ok") return hit.uri;

  const requestId = `res_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  pendingResourceRequestIds.set(requestId, cacheKey);
  resolvedImageCache.set(cacheKey, { kind: "pending" });
  post({ type: "REQUEST_RESOURCE_URI", requestId, href, fromUri, kind });
  return null;
}

function parseSize(raw: string | undefined): { width?: number; height?: number } | null {
  if (!raw) return null;
  const m = /^\s*(\d+)\s*(?:[x×]\s*(\d+)\s*)?$/.exec(raw);
  if (!m) return null;
  const width = Number(m[1]);
  const height = m[2] ? Number(m[2]) : undefined;
  if (!Number.isFinite(width) || width <= 0) return null;
  if (height != null && (!Number.isFinite(height) || height <= 0)) return null;
  return { width, height };
}

function parseHtmlImgTag(tagText: string): { src: string; alt?: string; width?: number; height?: number } | null {
  const t = tagText.trim();
  if (!/^<img\b/i.test(t)) return null;

  const readAttr = (name: string): string | undefined => {
    const re = new RegExp(`${name}\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i");
    const m = re.exec(t);
    if (!m) return undefined;
    return (m[2] ?? m[3] ?? m[4] ?? "").trim();
  };

  const src = readAttr("src");
  if (!src) return null;
  const alt = readAttr("alt");

  const widthRaw = readAttr("width");
  const heightRaw = readAttr("height");
  const width = widthRaw && /^\d+$/.test(widthRaw) ? Number(widthRaw) : undefined;
  const height = heightRaw && /^\d+$/.test(heightRaw) ? Number(heightRaw) : undefined;

  return { src, alt: alt || undefined, width, height };
}

type ParsedTableRange = {
  headerLineNo: number;
  alignLineNo: number;
  endLineNo: number;
};

function parseGfmTableRangeAtLine(doc: Text, startLineNumber: number): ParsedTableRange | null {
  if (startLineNumber < 1 || startLineNumber > doc.lines) return null;

  const headerLine = doc.line(startLineNumber);
  const alignLineNo = startLineNumber + 1;
  if (alignLineNo > doc.lines) return null;
  const alignLine = doc.line(alignLineNo);

  const headerText = headerLine.text;
  const alignText = alignLine.text;
  if (!headerText.includes("|")) return null;
  if (!alignText.includes("|")) return null;

  const alignPattern = /^:?-{3,}:?$/;
  const splitAlignRow = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim().replace(/\s+/g, ""));
  };
  const alignCells = splitAlignRow(alignText);
  if (alignCells.length === 0) return null;
  if (!alignCells.every((c) => alignPattern.test(c))) return null;

  let endLineNo = alignLineNo;
  for (let ln = alignLineNo + 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const t = line.text.trim();
    if (t.length === 0) break;
    if (!t.includes("|")) break;
    endLineNo = ln;
  }

  return { headerLineNo: startLineNumber, alignLineNo, endLineNo };
}

type ParsedFencedCodeBlockRange = {
  startLineNo: number;
  endLineNo: number;
  fenceChar: "`" | "~";
  fenceLen: number;
  lang: string | null;
};

function parseFencedCodeBlockRangeAtLine(doc: Text, startLineNumber: number): ParsedFencedCodeBlockRange | null {
  if (startLineNumber < 1 || startLineNumber > doc.lines) return null;
  const startLine = doc.line(startLineNumber);
  const m = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]+)?\s*$/.exec(startLine.text);
  if (!m) return null;

  const fence = m[1] ?? "";
  const lang = (m[2] ?? "").trim();
  const fenceChar = fence[0] === "~" ? "~" : "`";
  const fenceLen = fence.length;

  let endLineNo = -1;
  const closeRe = /^\s*(```+|~~~+)\s*$/
  for (let ln = startLineNumber + 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const cm = closeRe.exec(line.text);
    if (!cm) continue;
    const closeFence = cm[1] ?? "";
    if (closeFence[0] !== fenceChar) continue;
    if (closeFence.length < fenceLen) continue;
    endLineNo = ln;
    break;
  }
  if (endLineNo < 0) return null;

  return {
    startLineNo: startLineNumber,
    endLineNo,
    fenceChar,
    fenceLen,
    lang: lang.length > 0 ? lang : null
  };
}

class CodeBlockLangWidget extends WidgetType {
  constructor(private readonly lang: string | null) {
    super();
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "md-codeblock-lang";
    span.textContent = this.lang ?? "";
    span.style.pointerEvents = "none";
    return span;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "md-hr";
    wrap.style.pointerEvents = "none";
    return wrap;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly view: EditorView,
    private readonly checked: boolean,
    private readonly bracketFrom: number,
    private readonly bracketTo: number
  ) {
    super();
  }
  eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked && this.bracketFrom === other.bracketFrom && this.bracketTo === other.bracketTo;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `md-task-checkbox${this.checked ? " md-task-checkbox--checked" : ""}`;
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", this.checked ? "true" : "false");
    span.tabIndex = 0;

    const toggle = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.view.focus();
      this.view.dispatch({
        changes: {
          from: this.bracketFrom,
          to: this.bracketTo,
          insert: this.checked ? "[ ]" : "[x]"
        }
      });
    };
    span.addEventListener("mousedown", toggle);
    span.addEventListener("click", toggle);
    span.addEventListener("keydown", (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      toggle(e);
    });

    return span;
  }
  ignoreEvent() {
    return true;
  }
}

function livePreviewPlugin() {
  return ViewPlugin.fromClass(
    class {
      decorations: any;
      constructor(private readonly view: EditorView) {
        this.decorations = this.safeBuildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.transactions.some((t) => t.effects.some((e) => e.is(forceRedrawEffect)))
        ) {
          this.decorations = this.safeBuildDecorations(update.view);
        }
      }

      safeBuildDecorations(view: EditorView) {
        try {
          const deco = this.buildDecorations(view);
          return deco;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const detail = e instanceof Error ? e.stack : undefined;
          showBanner(`Live preview error: ${message}`);
          post({ type: "BOOT_ERROR", message, detail });
          throw e;
        }
      }

      buildDecorations(view: EditorView) {
        const builder: any[] = [];
        const mode = settings?.syntaxVisibility ?? "smart";
        const sel = view.state.selection.main;
        const selectionOverlaps = (from: number, to: number) => {
          // Treat a cursor (empty selection) as overlapping when it sits on the boundary.
          // This is important for "click to edit" widgets that place the caret at the start of a hidden region.
          if (sel.from === sel.to) return from <= sel.from && sel.from <= to;
          return !(to <= sel.from || from >= sel.to);
        };
        const clampToDoc = (pos: number) => Math.max(0, Math.min(view.state.doc.length, pos));
        const dimSyntax = (from: number, to: number) => {
          if (from >= to) return;
          let cls = "qm-syntax";
          if (mode === "minimal") cls += " qm-syntax-dim";
          if (mode === "always") cls += "";
          if (mode === "smart") {
            if (!selectionOverlaps(from, to)) cls += " qm-syntax-dim";
          }
          builder.push(Decoration.mark({ class: cls }).range(from, to));
        };

        const addMark = (from: number, to: number, cls: string) => {
          if (from >= to) return;
          builder.push(Decoration.mark({ class: cls }).range(from, to));
        };

        for (const r of view.visibleRanges) {
          let pos = r.from;
          while (pos <= r.to) {
            const line = view.state.doc.lineAt(pos);
            if (line.from >= r.to) break;
            const rawText = line.text;

            // 引用プレフィックス（"> " が複数重なるケース含む）
            const quoteMatch = /^(\s*(?:>\s*)+)(.*)$/.exec(rawText);
            const quotePrefix = quoteMatch ? quoteMatch[1] ?? "" : "";
            const quoteDepth = quotePrefix ? (quotePrefix.match(/>/g) ?? []).length : 0;
            const text = quoteMatch ? quoteMatch[2] ?? "" : rawText;
            const baseOffset = line.from + quotePrefix.length;

            if (quotePrefix) {
              const cls = `md-quote-line md-quote-depth-${Math.min(6, Math.max(1, quoteDepth))}`;
              builder.push(Decoration.line({ class: cls }).range(line.from));
              // 引用の ">" は薄くする（カーソル付近なら残す）
              if (!selectionOverlaps(line.from, clampToDoc(baseOffset + 1))) {
                // ">" 自体は残す（編集しやすさ優先）。見た目だけ薄く。
                dimSyntax(line.from, baseOffset);
              } else {
                dimSyntax(line.from, baseOffset);
              }
            }

            // 水平線（--- / *** / ___）
            {
              const hr = /^\s*((?:-{3,})|(?:\*{3,})|(?:_{3,}))\s*$/.exec(text.replace(/\s+/g, ""));
              if (hr) {
                if (!selectionOverlaps(line.from, Math.min(view.state.doc.length, line.to + 1))) {
                  builder.push(Decoration.line({ class: "md-hr-line" }).range(line.from));
                  builder.push(Decoration.replace({}).range(baseOffset, line.to));
                  builder.push(
                    Decoration.widget({
                      widget: new HrWidget(),
                      side: 1
                    }).range(baseOffset)
                  );
                  pos = line.to + 1;
                  continue;
                }
              }
            }

            // フェンスコードブロック（編集時は生テキストを残す）
            {
              // 引用内のフェンスは現状は行頭限定（引用prefix付きは未対応）
              const block = quotePrefix ? null : parseFencedCodeBlockRangeAtLine(view.state.doc, line.number);
              if (block) {
                const startLine = view.state.doc.line(block.startLineNo);
                const endLine = view.state.doc.line(block.endLineNo);
                const blockFrom = startLine.from;
                const blockToInclusive = Math.min(view.state.doc.length, endLine.to + (block.endLineNo < view.state.doc.lines ? 1 : 0));

                if (!selectionOverlaps(blockFrom, blockToInclusive)) {
                  for (let ln = block.startLineNo; ln <= block.endLineNo; ln++) {
                    const l = view.state.doc.line(ln);
                    const isFence = ln === block.startLineNo || ln === block.endLineNo;
                    const isFirstBody = ln === block.startLineNo + 1;
                    const isLastBody = ln === block.endLineNo - 1;

                    let cls = "md-codeblock-line";
                    if (isFence) cls += " md-codeblock-fence";
                    if (isFirstBody) cls += " md-codeblock-first";
                    if (isLastBody) cls += " md-codeblock-last";
                    builder.push(Decoration.line({ class: cls }).range(l.from));

                    if (isFence) {
                      // フェンス行は表示しない（開始行は言語タグのみ表示）
                      builder.push(Decoration.replace({}).range(l.from, l.to));
                      if (ln === block.startLineNo && block.lang) {
                        builder.push(
                          Decoration.widget({
                            widget: new CodeBlockLangWidget(block.lang),
                            side: 1
                          }).range(l.from)
                        );
                      }
                    }
                  }

                  pos = endLine.to + 1;
                  continue;
                }
              }
            }

            // GFMテーブル（未編集中はMarkdownを隠してHTML表に置換）
            {
              // 引用内テーブルは現状未対応（行頭限定）
              const table = quotePrefix ? null : parseGfmTableRangeAtLine(view.state.doc, line.number);
              if (table) {
                const headerLine = view.state.doc.line(table.headerLineNo);
                const endLine = view.state.doc.line(table.endLineNo);
                const tableFrom = headerLine.from;
                const tableEndExclusive = Math.min(
                  view.state.doc.length,
                  endLine.to + (table.endLineNo < view.state.doc.lines ? 1 : 0)
                );

                if (!selectionOverlaps(tableFrom, tableEndExclusive)) {
                  const parsed = parseGfmTable(view.state.doc, table);
                  if (parsed) {
                    // Insert a widget and collapse table lines so we don't leave large vertical gaps.
                    // NOTE: CodeMirror doesn't allow block decorations from ViewPlugins (boot error),
                    // so we keep this widget non-block and rely on CSS for layout.
                    builder.push(
                      Decoration.widget({
                        widget: new TableWidget(view, headerLine.from, parsed),
                        side: 1
                      }).range(tableFrom)
                    );

                    for (let ln = table.headerLineNo; ln <= table.endLineNo; ln++) {
                      const l = view.state.doc.line(ln);
                      builder.push(Decoration.replace({}).range(l.from, l.to));
                      builder.push(
                        Decoration.line({
                          class: ln === table.headerLineNo ? "md-table-host-line" : "md-table-hidden-line"
                        }).range(l.from)
                      );
                    }
                  }

                  pos = tableEndExclusive;
                  continue;
                }
              }
            }

            // タスクリスト（- [ ] / - [x]）はクリックでON/OFF
            {
              const m = /^(\s*)([-*+])(\s+)\[([ xX])\](\s+)/.exec(text);
              if (m) {
                const indentLen = m[1].length;
                const markerSpacesLen = m[3].length;
                const checked = (m[4] ?? "").toLowerCase() === "x";
                const afterBracketSpacesLen = m[5].length;

                const markerFrom = baseOffset + indentLen;
                const bracketFrom = markerFrom + 1 + markerSpacesLen;
                const bracketTo = bracketFrom + 3;
                const afterBracketTo = bracketTo + afterBracketSpacesLen;

                if (!selectionOverlaps(markerFrom, Math.min(view.state.doc.length, afterBracketTo))) {
                  // "- " などのリストマーカー部分を隠す
                  builder.push(Decoration.replace({}).range(markerFrom, bracketFrom));
                  // "[ ]" を隠してチェックボックスに置換
                  builder.push(Decoration.replace({}).range(bracketFrom, bracketTo));
                  // 後続スペースも詰める（widget側で余白を持つ）
                  builder.push(Decoration.replace({}).range(bracketTo, afterBracketTo));
                  builder.push(
                    Decoration.widget({
                      widget: new TaskCheckboxWidget(view, checked, bracketFrom, bracketTo),
                      side: 1
                    }).range(markerFrom)
                  );
                } else {
                  dimSyntax(markerFrom, markerFrom + 1);
                  dimSyntax(bracketFrom, bracketFrom + 1);
                  dimSyntax(bracketTo - 1, bracketTo);
                }
              }
            }

            // 箇条書き（- / * / +）のマーカーをObsidian風のドットで表示（編集中は元の記号を残す）
            {
              const m = /^(\s*)([-*+])(\s+)(?!\[[ xX]\])/.exec(text);
              if (m) {
                const indentLen = m[1].length;
                const markerLen = m[2].length; // always 1
                const spaceLen = m[3].length;
                const markerFrom = baseOffset + indentLen;
                const markerTo = markerFrom + markerLen;
                const markerRegionEnd = markerTo + spaceLen;

                if (!selectionOverlaps(markerFrom, markerRegionEnd)) {
                  // マーカー自体は消してウィジェットに置き換える
                  builder.push(Decoration.replace({}).range(markerFrom, markerTo));
                  builder.push(
                    Decoration.widget({
                      widget: new BulletWidget(),
                      side: 1
                    }).range(markerFrom)
                  );
                  // 直後のスペースは幅だけ確保したいので残す（見た目はCSS側で調整）
                  dimSyntax(markerFrom, markerTo);
                } else {
                  // 編集中は元の記号が見えるようにする（強制置換しない）
                  dimSyntax(markerFrom, markerTo);
                }
              }
            }

            // 見出し（ATXのみ。Setextは表示上は通常テキストとして扱う）
            const m = /^(#{1,6})(\s+)(.*)$/.exec(text);
            if (m) {
              const hashes = m[1].length;
              builder.push(Decoration.line({ class: `md-heading-line md-h${hashes}` }).range(line.from));
              dimSyntax(baseOffset, baseOffset + m[1].length);
              dimSyntax(baseOffset + m[1].length, baseOffset + m[1].length + m[2].length);
              addMark(baseOffset + m[1].length + m[2].length, line.to, `md-heading md-h${hashes}`);
            }
            // Setext（次の行が === / --- の場合）
            if (!m && line.number < view.state.doc.lines) {
              const next = view.state.doc.line(line.number + 1);
              const setext = /^(=+|-+)\s*$/.exec(next.text);
              if (setext && text.trim().length > 0) {
                const level = setext[1][0] === "=" ? 1 : 2;
                builder.push(Decoration.line({ class: `md-heading-line md-h${level}` }).range(line.from));
                addMark(baseOffset, line.to, `md-heading md-h${level}`);
                // 下線（====/----）は表示上ノイズになるので、編集していない時は隠す
                if (!selectionOverlaps(next.from, Math.min(view.state.doc.length, next.to + 1))) {
                  builder.push(Decoration.replace({}).range(next.from, next.to));
                } else {
                  dimSyntax(next.from, next.to);
                }
              }
            }

            // インラインコード
            for (const match of text.matchAll(/`([^`]+)`/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const full = match[0];
              const from = baseOffset + start;
              const to = from + full.length;
              const openTickFrom = from;
              const openTickTo = from + 1;
              const closeTickFrom = to - 1;
              const closeTickTo = to;
              const innerFrom = openTickTo;
              const innerTo = closeTickFrom;

              addMark(innerFrom, innerTo, "md-inline-code");

              // 編集中は元の記号を残す（選択/カーソルが範囲内にある場合）
              if (selectionOverlaps(from, to)) {
                dimSyntax(openTickFrom, openTickTo);
                dimSyntax(closeTickFrom, closeTickTo);
              } else {
                builder.push(Decoration.replace({}).range(openTickFrom, openTickTo));
                builder.push(Decoration.replace({}).range(closeTickFrom, closeTickTo));
              }
            }

            // 太字（簡易）
            for (const match of text.matchAll(/\*\*([^\*]+)\*\*/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const full = match[0];
              dimSyntax(baseOffset + start, baseOffset + start + 2);
              addMark(baseOffset + start + 2, baseOffset + start + full.length - 2, "md-bold");
              dimSyntax(baseOffset + start + full.length - 2, baseOffset + start + full.length);
            }

            // 斜体（簡易）
            for (const match of text.matchAll(/(^|[^\*])\*([^\*]+)\*/g)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const prefixLen = match[1].length;
              const inner = match[2];
              const open = baseOffset + start + prefixLen;
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
              const openBracket = baseOffset + start + (bang ? 1 : 0);
              if (bang) dimSyntax(baseOffset + start, baseOffset + start + 1);
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
                const cached = resolvedImageCache.get(cacheKey);
                const resolved = cached?.kind === "ok" ? cached.uri : null;
                const error = cached?.kind === "error" ? cached.error : null;
                if (!resolved && !error) {
                  requestResourceUri("image", href, documentUri);
                }
                const widgetPos = openBracket + 1 + label.length + 2 + href.length + 1;
                builder.push(
                  Decoration.widget({
                    widget: new ImageWidget({ src: resolved, error, href }),
                    side: 1
                  }).range(widgetPos)
                );
              }
            }

            // HTML img（GitHub互換の画像サイズ指定用）
            // 例: <img src="images/sample.png" width="200" /> / <img src="..." width="200" height="120">
            for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
              const start = match.index ?? -1;
              if (start < 0) continue;
              const raw = match[0];
              const info = parseHtmlImgTag(raw);
              if (!info) continue;

              const href = info.src;
              if (settings) {
                if (/^https?:\/\//i.test(href) && !settings.security.allowExternalImages) {
                  continue;
                }
                const cacheKey = `${documentUri}::${href}`;
                const cached = resolvedImageCache.get(cacheKey);
                const resolved = cached?.kind === "ok" ? cached.uri : null;
                const error = cached?.kind === "error" ? cached.error : null;
                if (!resolved && !error) {
                  requestResourceUri("image", href, documentUri);
                }
                const widgetPos = baseOffset + start + raw.length;
                builder.push(
                  Decoration.widget({
                    widget: new ImageWidget({
                      src: resolved,
                      error,
                      href,
                      width: info.width,
                      height: info.height
                    }),
                    side: 1
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

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "md-bullet";
    span.textContent = "•";
    return span;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly opts: {
      src: string | null;
      error: string | null;
      href: string;
      width?: number;
      height?: number;
    }
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      this.opts.src === other.opts.src &&
      this.opts.error === other.opts.error &&
      this.opts.href === other.opts.href &&
      this.opts.width === other.opts.width &&
      this.opts.height === other.opts.height
    );
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "md-embed-image";
    if (this.opts.error) {
      wrap.classList.add("md-embed-image--error");
      const t = document.createElement("div");
      const detail = this.opts.error === "not_found" ? "Not found" : this.opts.error;
      t.textContent = `Failed to load image: ${detail}`;
      const p = document.createElement("div");
      p.textContent = this.opts.href;
      p.style.opacity = "0.8";
      p.style.fontSize = "12px";
      wrap.appendChild(t);
      wrap.appendChild(p);
      return wrap;
    }
    if (!this.opts.src) {
      const t = document.createElement("div");
      t.textContent = "Loading image…";
      t.style.opacity = "0.7";
      t.style.fontSize = "12px";
      wrap.appendChild(t);
      return wrap;
    }
    const img = document.createElement("img");
    img.src = this.opts.src;
    img.style.maxWidth = "100%";
    img.style.borderRadius = "10px";
    img.loading = "lazy";
    if (this.opts.width) img.style.width = `${this.opts.width}px`;
    if (this.opts.height) img.style.height = `${this.opts.height}px`;
    wrap.appendChild(img);
    return wrap;
  }
}

let documentUri = "";
let hoverTimer: number | null = null;
let lastHoverHref: string | null = null;
let lastHoverPoint: { x: number; y: number } | null = null;
let pendingPreviewRequestId: string | null = null;
let modifierHoverHandlersAttached = false;
let setModifierMode: (active: boolean) => void = () => {};
let lastModifierHoverRange: { from: number; to: number } | null = null;

function attachDomHandlers(view: EditorView) {
  if (!modifierHoverHandlersAttached) {
    modifierHoverHandlersAttached = true;
    setModifierMode = (active: boolean) => {
      document.body.classList.toggle("quench-mod", active);
    };
    window.addEventListener("keydown", (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      setModifierMode(Boolean(e.ctrlKey || e.metaKey));
    });
    window.addEventListener("keyup", (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      setModifierMode(Boolean(e.ctrlKey || e.metaKey));
    });
    window.addEventListener("blur", () => setModifierMode(false));
  }

  view.dom.addEventListener("click", (e) => {
    if (!(e instanceof MouseEvent)) return;
    setModifierMode(Boolean(e.ctrlKey || e.metaKey));
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
    // Some environments don't reliably deliver modifier-only keydown/keyup events to the webview.
    // Use the mouse event state as the source of truth for Ctrl/⌘ modifier mode.
    const modActive = Boolean(e.ctrlKey || e.metaKey);
    setModifierMode(modActive);

    // Ctrl/⌘+hover affordance: explicitly mark the hovered link range so styling doesn't rely on tokenizer classes.
    {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (!modActive || pos == null) {
        if (lastModifierHoverRange) {
          lastModifierHoverRange = null;
          view.dispatch({ effects: setModifierHoverLinkEffect.of(null) });
        }
      } else {
        const link = findLinkAt(view, pos);
        if (!link) {
          if (lastModifierHoverRange) {
            lastModifierHoverRange = null;
            view.dispatch({ effects: setModifierHoverLinkEffect.of(null) });
          }
        } else {
          const nextRange = { from: link.from, to: link.to };
          if (!lastModifierHoverRange || lastModifierHoverRange.from !== nextRange.from || lastModifierHoverRange.to !== nextRange.to) {
            lastModifierHoverRange = nextRange;
            view.dispatch({ effects: setModifierHoverLinkEffect.of(nextRange) });
          }
        }
      }
    }
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
    if (lastModifierHoverRange) {
      lastModifierHoverRange = null;
      view.dispatch({ effects: setModifierHoverLinkEffect.of(null) });
    }
    setModifierMode(false);
    hidePreview();
  });

  view.dom.addEventListener(
    "paste",
    async (e) => {
      if (!(e instanceof ClipboardEvent)) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const items = [...dt.items];
      const imageItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!imageItem) return;

      const file = imageItem.getAsFile();
      if (!file) return;
      e.stopPropagation();
      e.preventDefault();

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sel = view.state.selection.main;
    const requestId = `att_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    showBanner("Saving image as an attachment…");
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
    },
    true
  );

  view.dom.addEventListener(
    "drop",
    async (e) => {
      if (!(e instanceof DragEvent)) return;
      if (!e.dataTransfer) return;

      const uriList = e.dataTransfer.getData("text/uri-list");
      if (uriList) {
      const first = uriList.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith("#"));
      if (first) {
        e.stopPropagation();
        e.preventDefault();
        const sel = view.state.selection.main;
        const requestId = `ref_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        showBanner("Inserting image reference…");
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
    e.stopPropagation();
    e.preventDefault();

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sel = view.state.selection.main;
    const requestId = `att_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    showBanner("Saving image as an attachment…");
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
    },
    true
  );

  view.dom.addEventListener(
    "dragover",
    (e) => {
      if (!(e instanceof DragEvent)) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );
}

function findLinkHrefAt(view: EditorView, pos: number): string | null {
  return findLinkAt(view, pos)?.href ?? null;
}

function findLinkAt(view: EditorView, pos: number): { href: string; from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const offsetInLine = pos - line.from;
  const within = (start: number, end: number) => offsetInLine >= start && offsetInLine <= end;

  const trimPunctuation = (s: string): string => {
    let out = s.trim();
    // Trim common wrappers/punctuation around plain paths/urls (not meant for Markdown link syntax).
    // Keep leading '#' for in-document fragments.
    while (out.length > 0) {
      const first = out[0];
      if (first === "#" || /[A-Za-z0-9]/.test(first)) break;
      if (first === "/" || first === "." || first === "~") break;
      if (first === "<" || first === "(" || first === "[" || first === "{" || first === "\"" || first === "'") {
        out = out.slice(1);
        continue;
      }
      break;
    }
    while (out.length > 0) {
      const last = out[out.length - 1];
      if (/[A-Za-z0-9]/.test(last)) break;
      if (last === "/" || last === "_" || last === "-") break;
      if (last === ">" || last === ")" || last === "]" || last === "}" || last === "," || last === "." || last === ";" || last === ":" || last === "\""
        || last === "'") {
        out = out.slice(0, -1);
        continue;
      }
      break;
    }
    return out.trim();
  };

  const rangeFromTrimmed = (raw: string, rawStart: number): { token: string; from: number; to: number } => {
    const token = trimPunctuation(raw);
    if (!token) return { token: "", from: rawStart, to: rawStart };
    const idx = raw.indexOf(token);
    if (idx < 0) return { token, from: rawStart, to: rawStart + raw.length };
    return { token, from: rawStart + idx, to: rawStart + idx + token.length };
  };

  const extractTokenAt = (): { token: string; from: number; to: number } | null => {
    // Conservative tokenization for "plain path / url" on a single line.
    // We don't try to be smart across whitespace or nested punctuation.
    const isTokenChar = (ch: string) => /[A-Za-z0-9_./~:#@%+=-]/.test(ch);
    if (offsetInLine < 0 || offsetInLine > text.length) return null;
    const idx = Math.min(Math.max(offsetInLine, 0), Math.max(text.length - 1, 0));
    if (text.length === 0) return null;
    if (!isTokenChar(text[idx])) return null;
    let left = idx;
    let right = idx;
    while (left - 1 >= 0 && isTokenChar(text[left - 1])) left--;
    while (right + 1 < text.length && isTokenChar(text[right + 1])) right++;
    const raw = text.slice(left, right + 1);
    const ranged = rangeFromTrimmed(raw, left);
    if (!ranged.token) return null;
    return { token: ranged.token, from: line.from + ranged.from, to: line.from + ranged.to };
  };

  for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const bang = match[1] === "!";
    const label = match[2] ?? "";
    const href = (match[3] ?? "").trim();
    const full = match[0] ?? "";
    const end = start + full.length;
    if (!within(start, end)) continue;
    const openBracket = start + (bang ? 1 : 0);
    const labelFrom = openBracket + 1;
    const labelTo = labelFrom + label.length;
    const hrefFrom = labelTo + 2; // ](
    const hrefTo = hrefFrom + (match[3] ?? "").length;
    if (within(labelFrom, labelTo)) return { href, from: line.from + labelFrom, to: line.from + labelTo };
    if (within(hrefFrom, hrefTo)) return { href, from: line.from + hrefFrom, to: line.from + hrefTo };
    return { href, from: line.from + start, to: line.from + end };
  }

  // HTML image tag (GitHub-compatible sizing): <img src="..." ...>
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const raw = match[0];
    const end = start + raw.length;
    if (!within(start, end)) continue;
    const info = parseHtmlImgTag(raw);
    if (info?.src) return { href: info.src.trim(), from: line.from + start, to: line.from + end };
  }

  // Angle-bracket autolinks: <https://...> / <mailto:...>
  for (const match of text.matchAll(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const full = match[0];
    const end = start + full.length;
    if (!within(start, end)) continue;
    const inner = (match[1] ?? "").trim();
    const innerStart = start + 1;
    const innerEnd = innerStart + inner.length;
    return { href: inner, from: line.from + innerStart, to: line.from + innerEnd };
  }

  // Bare URLs (GitHub-ish): https://...
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+/g)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const full = match[0];
    const end = start + full.length;
    if (!within(start, end)) continue;
    const ranged = rangeFromTrimmed(full, start);
    if (!ranged.token) continue;
    return { href: ranged.token, from: line.from + ranged.from, to: line.from + ranged.to };
  }

  // Plain paths (e.g. docs/file.md, ./file.md, ../img.png, #heading)
  const token = extractTokenAt();
  if (!token) return null;
  if (token.token.startsWith("#")) return { href: token.token, from: token.from, to: token.to }; // in-document fragment
  if (/^https?:\/\//i.test(token.token) || /^mailto:/i.test(token.token)) return { href: token.token, from: token.from, to: token.to };
  // Require a strong "path-like" shape to avoid accidental opens.
  const looksPathLike =
    token.token.startsWith("./") ||
    token.token.startsWith("../") ||
    token.token.startsWith("/") ||
    token.token.includes("/") ||
    /^[A-Za-z]:[\\/]/.test(token.token) ||
    /\.[A-Za-z0-9]{1,6}(?:#.+)?$/.test(token.token);
  if (looksPathLike) return { href: token.token, from: token.from, to: token.to };

  return null;
}

const handleMessageEvent = (event: MessageEvent) => {
  let msg: ExtensionToWebviewMessage;
  try {
    msg = assertExtensionToWebviewMessage(event.data);
  } catch (e) {
    showBanner(e instanceof Error ? e.message : String(e));
    return;
  }

  switch (msg.type) {
    case "INIT": {
      applySettings(msg.settings);
      applyThemeKind(msg.themeKind);
      documentUri = msg.documentUri;
      lastConfirmedVersion = msg.version;
      applyCss(msg.cssText);
      initEditor(msg.text);
      hideBanner();
      break;
    }
    case "THEME_CHANGED": {
      applyThemeKind(msg.themeKind);
      break;
    }
    case "SETTINGS_UPDATED": {
      applySettings(msg.settings);
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
      if (msg.ok && msg.uri) resolvedImageCache.set(cacheKey, { kind: "ok", uri: msg.uri });
      else resolvedImageCache.set(cacheKey, { kind: "error", error: msg.error ?? "unknown" });
      if (view) view.dispatch({ effects: forceRedrawEffect.of(undefined) });
      break;
    }
    case "CREATE_ATTACHMENT_RESULT": {
      if (!msg.ok) {
        showBanner(`Failed to attach image: ${msg.error ?? "unknown"}`);
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
};

const boot = (window as any).__quench_boot as undefined | { setHandler: (h: (ev: MessageEvent) => void) => void };
if (boot && typeof boot.setHandler === "function") {
  boot.setHandler(handleMessageEvent);
} else {
  window.addEventListener("message", handleMessageEvent);
  setTimeout(() => {
    console.log("[Quench] Sending WEBVIEW_READY message");
    post({ type: "WEBVIEW_READY" });
  }, 0);
}

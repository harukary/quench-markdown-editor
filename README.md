# Quench Markdown Editor

An **Obsidian-like Live Preview** Markdown editor for VS Code, implemented as a **Custom Editor (Webview)**.

This extension focuses on:

- A clean, beautiful Live Preview editing experience inside VS Code
- Workspace-scoped theming via `.vscode/quench-theme.css`
- Image paste/drop → save as attachment → insert a relative path
- GitHub-friendly Markdown defaults (GFM-first mindset)

## Features (current)

- Custom Editor: `quench.markdownEditor` (priority: `option`)
- Editing with CodeMirror 6 in a Webview
- Writes back via `WorkspaceEdit` (Undo/Redo handled by VS Code)
- Injects workspace CSS (`quench.css.files`) into the Webview, with optional reload-on-save
- Commands:
  - `Quench: Reload CSS`
  - `Quench: Create Theme CSS (Workspace)`
  - `Quench: Insert Image from File`
  - `Quench: Resize Image (GitHub-compatible)`

## Development

1) Install dependencies

```bash
npm install
```

2) Build (Webview bundle + Extension compile)

```bash
npm run build
```

3) Open this folder in VS Code and press `F5` to launch the Extension Host

4) Open a `.md` file and select **Open With... → Quench Markdown Editor**

## Settings

- `quench.css.files`: List of workspace-relative CSS file paths
- `quench.css.reloadOnSave`: Auto re-inject CSS on save (helper; watcher is primary)

## Global Settings (UI)

Run `Quench: Open Settings` to edit global overrides stored under VS Code `globalStorage`.

- Theme overrides from this UI are applied after `quench.css.files` (later wins inside the Webview).

See `docs/master.md` for more details.

## Support

If you find Quench helpful, you can support its development here:

- Buy Me a Coffee: https://buymeacoffee.com/harukary7518

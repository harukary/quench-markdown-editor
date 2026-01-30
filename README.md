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

## Git Diff (Text Editor)

If you set Markdown (`*.md`) to open with Quench by default, VS Code's Git diff may also open Markdown in Quench.
To keep Quench as the default editor for normal Markdown files, while using the **Text Editor diff view** for Git changes, use one of the options below.

### Alternative workflow: keep Text Editor as default

If you want **Git "Open Changes"** to always work as the standard Text Editor diff, keep Markdown default as Text Editor:

```json
{
  "*.md": "default"
}
```

Then open Quench only when you want it, using:

- `Quench: Open in Quench` (also available as an editor title button on `.md` files)

### Option A) Set editor associations (recommended)

Run:

- `Quench: Use Text Editor in Git Diff for Markdown`

This writes the following keys to your **global** VS Code settings (`workbench.editorAssociations`):

```json
{
  "*.md": "quench.markdownEditor",
  "git:/**/*.md": "default",
  "gitlens:/**/*.md": "default"
}
```

Notes:

- `git:` is used by VS Code built-in Git diff editors.
- `gitlens:` is used by GitLens (if installed).

### Option B) Open a diff explicitly (command)

Use:

- `Quench: Open Git Diff (Text Editor)`

This opens a Text Editor diff of `HEAD` vs working tree for the selected Markdown file.
You can also find this command in the Source Control view's context menu.

### Known limitations / troubleshooting

- Quick test flow:
  1. Open the Command Palette and run `Quench: Use Text Editor in Git Diff for Markdown`.
  2. Reload VS Code window (`Developer: Reload Window`).
  3. In Source Control → Changes, click a changed `*.md` and confirm it opens as a **diff** in the Text Editor.

- **Untracked files** cannot be diffed against `HEAD` (there is no `HEAD` version). Stage/commit first, or compare manually.
- If the command does not appear or does nothing, confirm:
  - The extension is installed/enabled, and the command shows up in the Command Palette.
  - Your user settings contain `git:/**/*.md` / `gitlens:/**/*.md` under `workbench.editorAssociations`.

## Global Settings (UI)

Run `Quench: Open Settings` to edit global overrides stored under VS Code `globalStorage`.

- Theme overrides from this UI are applied after `quench.css.files` (later wins inside the Webview).

See `docs/master.md` for more details.

## Support

If you find Quench helpful, you can support its development here:

- Buy Me a Coffee: https://buymeacoffee.com/harukary7518

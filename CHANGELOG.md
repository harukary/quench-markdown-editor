# Changelog

このファイルは **リリースごとの変更** を管理します。**最新が一番上** です。

## [Unreleased]

## [0.0.14] - 2026-02-04
### Fixed
- Quench エディタ上で `Tab` / `Shift-Tab` によるインデント / アウトデントが効かない問題を修正。

### Added
- `Tab` / `Shift-Tab` の挙動を Quench Settings（Keybindings）から上書きできる項目（Indent / Outdent）を追加。

## [0.0.13] - 2026-01-30
### Added
- Git差分表示（Diffビュー）で `.md` を Text Editor で扱うためのコマンド `Quench: Use Text Editor in Git Diff for Markdown` を追加（`workbench.editorAssociations` に `git:/**/*.md` / `gitlens:/**/*.md` を設定）。
- `.md` を Text Editor 既定のまま、必要なときだけ Quench で開ける導線を追加（エディタタイトルのアイコンボタン / コマンド `Quench: Open in Quench`）。

### Fixed
- `Quench: Open in Quench` 実行時にタブの閉じ方によって `Tab close: Invalid tab not found!` が出る場合がある問題を修正。

### Changed
- `Quench: Open in Quench` は「追加で開く」ではなく「開き直し（置き換え）」になるよう挙動を変更（未保存の場合は安全のため中断）。

## [0.0.12] - 2026-01-29
### Fixed
- Live Preview で、強調の解釈/ハイライトの影響により本文全体が太字/斜体に見えることがある問題を修正（CodeMirror のトークン装飾を中和し、Quench 側の装飾に一本化）。
- Webview 内でフォントが `monospace` に固定され、太字差が出にくい/見た目が崩れることがある問題を修正（VS Code の editor font 設定を反映し、CodeMirror 側の font-family 指定を上書き）。

## [0.0.11] - 2026-01-28
### Fixed
- Webview 起動時に `Block decorations may not be specified via plugins` でクラッシュして Quench エディタが開けない場合がある問題を修正。

## [0.0.10] - 2026-01-28
### Added
- Quench Settings から Webview 内ショートカット（CodeMirror keymap）を編集・保存できる機能を追加。
- Keybindings入力欄で、実キー入力（Cmd/Ctrl/Shift/Alt + 任意キー）からCodeMirror形式（例: `Mod-l`）を自動入力できるように改善。
- Quench 側に Markdown 整形ショートカットを追加（`Cmd+1..6` 見出し、`Cmd+'` 箇条書き、`Cmd+L` / `Shift+Cmd+'` チェックボックス）。
- Quench 側に複数選択ショートカットを追加（`Cmd+D` 次一致、`Shift+Cmd+L` 全一致）。

### Fixed
- Quench Settings の Keybindings が全Quenchエディタへ反映されない問題を修正（`SETTINGS_UPDATED` で動的にkeymapを差し替え）。

## [0.0.9] - 2026-01-28
### Fixed
- テーブル表示の実装変更により Webview が起動できない場合がある問題を修正（CodeMirrorの制約に合わせて `block` デコレーションを排除）。
- Ctrl/⌘+Hover のリンク強調（青＋下線）が環境によって効かない問題を修正（プレーンURL/パスも含めてホバー中の範囲を明示的に装飾）。

### Added
- Ctrl/⌘+Hover のリンク強調色を、Quench Settings（Global Theme Override）から設定可能に追加（dark/light）。

## [0.0.8] - 2026-01-28
### Changed
- Live Preview のGFMテーブル表示を「行装飾」から「HTMLテーブル描画（ブロックウィジェット）」に変更し、一般的な表に近い見た目に改善。

## [0.0.7] - 2026-01-28
### Fixed
- カーソル色の上書きが環境によって効かず黒く見える場合がある問題を修正（`caret-color` の上書きを強制）。
- Live Preview の太字/斜体が効かない、または全体が太字っぽく見える問題を修正（`md-bold`/`md-italic` のCSS追加と基本フォントウェイトの明確化）。

## [0.0.6] - 2026-01-28
### Fixed
- カーソル色のグローバル上書きが、ワークスペースCSS等でCodeMirrorの描画（`caret-color` / `.cm-cursor`）を上書きしている場合に反映されないことがある問題を修正（グローバルTheme CSSでカーソル描画ルールを再注入）。

## [0.0.5] - 2026-01-28
### Fixed
- グローバル設定（Quench Settings UI）の Theme 上書きが、ワークスペースCSS（`quench.css.files`）に上書きされて反映されないケースを修正（CSS注入順序の見直し）。
- 起動直後にグローバル設定読み込みが遅れても、既に開いているWebviewへ反映されるように改善。

### Changed
- Settings UI に Theme の優先順位（`quench.css.files` の後に適用）を明記。

## [0.0.4] - 2026-01-26
### Added
- グローバル設定（`globalStorage` の `quench-settings.json`）と Settings UI（`Quench: Open Settings`）。

### Changed
- Settings UI の色入力（カラーピッカー/テキスト入力）を改善。
- modifier-hover（Ctrl/⌘+hover）リンクの見た目を改善。

## [0.0.3] - 2026-01-25
### Fixed
- Webview 初期化時の `themeKind` 互換性を改善。

## [0.0.2] - 2026-01-24
### Added
- 拡張機能アイコンの追加。
- スポンサーリンクの追加。

### Changed
- Marketplace向けのメタデータ/説明文を整理。

## [0.0.1] - 2026-01-23
### Added
- CodeMirror 6 ベースの Live Preview（Custom Editor / Webview）。
- 設定・ワークスペースインデックス・見出し/リンク処理などの基盤（`Settings` / `WorkspaceIndex` / `HeadingService` / `LinkService`）。
- テーマ/画像/装飾まわりの改善（初期実装）。

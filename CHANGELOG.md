# Changelog

このファイルは **リリースごとの変更** を管理します。**最新が一番上** です。

## [Unreleased]

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

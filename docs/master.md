## Quench Markdown Editor マスタードキュメント

## 関連ドキュメント

- 詳細設計: `docs/vscode-extension-detail-design.md`
- 開発計画: `docs/vscode-extension-development-plan.md`

## 1. 目的

Quench Markdown Editor は、**VSCodeでObsidianのような美しいLive PreviewでMarkdown編集を可能にする**ことを目的とする。
編集は常にLive Previewで行い、Markdownの保存内容は純Markdownのまま維持する。
リンクは Markdown link のみ（`[text](path)`）を扱い、見出しや本文の見た目はユーザーCSSで細かく制御できるようにする。

## 2. 概要

- 対象：VSCode上のMarkdown（`.md`）
- 編集体験：Live Previewのみ（Reading view / Source mode は提供しない）
- 対応リンク：Markdown link / Markdown image のみ
- 表示カスタマイズ：外部CSSファイルを読み込み、ホットリロードで反映
- 画像挿入：貼り付け/ドロップで「保存＋埋め込み挿入」まで自動化

## 3. ゴール

- Live PreviewでMarkdownを快適に編集できる
- Markdown linkの挿入・移動・プレビューが滑らかにできる
- 画像の貼り付け/ドロップで「保存＋埋め込み挿入」が完結する
- 見出しの色・フォントサイズ・余白などをCSSで自由に調整できる
- 大きなMarkdownでも破綻しにくい（表示範囲中心、遅延処理）

## 4. 非ゴール

- Reading view / Source mode の提供（Live Previewのみ）
- Obsidian固有構文や拡張Markdown（wikilink、callout等）の対応
- Markdown link以外のリンク表現の生成（wikilinkなど）
- 既存Markdownレンダリング互換性を極限まで追うこと（標準Markdown中心）

## 5. ユーザー体験

## 5.1 Live Preview表示ルール

- テキストは常にMarkdownとして保持する（保存されるのは純Markdown）
- 見た目は整形表示（見出し、太字、斜体、インラインコード、リンク、リスト）
- 編集しやすさのために「カーソル周辺だけ記号を見せる」
  - 例：`[label](path)` のURL部分はカーソル外では薄く、カーソル内では通常表示
  - 例：見出しの `#` はカーソル外では薄く、カーソル内では通常表示

- リンク操作
  - Ctrl/Cmd + クリックでリンク先を開く（ワークスペース内を優先）
  - ホバーでプレビューカード（任意設定）

## 5.2 Markdown link挿入

- `Quench: Insert Markdown Link`
  - ワークスペース内の`.md`を候補として表示（QuickPick）
  - 選択範囲があればそれをラベルに、なければファイル名をラベルにする
  - 生成：`[label](relative/path/to/file.md)`

- 見出しリンク
  - `Quench: Insert Link to Heading`
  - 対象ノートの見出し一覧を提示し、`[label](file.md#anchor)` を生成

- アンカー（`#anchor`）生成ルール
  - 既定はGitHub風slug（小文字、空白→`-`、記号除去、重複は連番）
  - 設定で切替可能

## 5.3 画像挿入

- 画像貼り付け（クリップボード）
  - 添付ファイルとして保存し、`![](relative/path.png)` を挿入

- 画像ドロップ（ドラッグ&ドロップ）
  - ワークスペース外：コピーして添付化 → `![](...)` 挿入
  - ワークスペース内：既定は参照リンク（設定でコピー添付化も可能）

- 表示
  - Live Previewで画像サムネイルを表示
  - 表示サイズはCSSと設定で制御（Markdown本文にはサイズ情報を埋め込まない）

## 5.4 任意の埋め込み（オプション）

標準Markdownの範囲で、HTMLスニペットを挿入する方式。

- `Quench: Insert Embed`
  - audio：`<audio controls src="..."></audio>`
  - video：`<video controls src="..."></video>`
  - pdf：`<iframe src="..."></iframe>` など

- セキュリティと互換性のため、既定は無効にできる

## 6. 主要機能要件

- カスタムエディタとしてMarkdownを開ける（Live Preview専用）
- Markdown linkの作成支援（ファイル選択、見出し選択、相対パス生成）
- ローカル画像の添付管理（貼り付け/ドロップ → 保存 → 参照挿入）
- CSSの外部読み込みとホットリロード
- リンクホバーのプレビュー（設定でON/OFF）
- 大きいファイルでも重くなりすぎない（遅延処理、viewport優先）

## 7. 非機能要件

- 安全性
  - 外部画像・外部iframeなどは既定でブロック（設定で許可）
  - Webview CSPを厳格に

- 互換性
  - `vscode.workspace.fs` を基本にし、Remote/WSL/SSHでも動作

- パフォーマンス
  - デコレーションは表示範囲中心で更新
  - 見出し解析は必要時のみ（遅延）

- UX
  - Undo/RedoはVSCodeの標準履歴に統合される
  - 既存の`.md`を壊さない（保存内容はMarkdownのまま）

## 8. アーキテクチャ

## 8.1 実装方式

- VSCode Custom Editor（`CustomTextEditorProvider`）で`.md`をWebviewに表示
- Webview内でエディタを実装（CodeMirror 6想定）
- 解析結果に応じて装飾（Decoration）とウィジェット（画像サムネイル）を重ねる

## 8.2 コンポーネント

- Extension Host（TypeScript）
  - `QuenchEditorProvider`：Custom editor
  - `WorkspaceIndex`：`.md`と添付の索引
  - `LinkService`：相対パス生成、リンクジャンプ、見出し抽出
  - `AttachmentService`：貼り付け/ドロップ保存、命名、パス決定
  - `CssService`：CSS読込、監視、Webviewへ注入
  - `SecurityPolicy`：外部読み込み制御、CSP生成

- Webview UI
  - エディタ本体（CodeMirror）
  - Live Previewデコレーション（クラス付与、薄表示/折りたたみ）
  - 画像サムネイルウィジェット
  - リンクホバーのプレビューUI

## 8.3 ドキュメント同期

- 真実のソースはVSCodeの`TextDocument`
- Webview → Extension：編集差分を送信（`APPLY_EDIT`）
- Extension：`WorkspaceEdit`で適用し、Undo/Redo整合性を保つ
- Extension → Webview：外部変更や確定差分を返す（`DOC_PATCH`）

## 8.4 メッセージプロトコル（概要）

- Extension → Webview
  - `INIT`: `{ text, settings, cssText[] }`
  - `DOC_PATCH`: `{ version, patches[] }`
  - `CSS_UPDATED`: `{ cssText[] }`
  - `INDEX_UPDATED`: `{ delta }`
  - `PREVIEW_RESULT`: `{ requestId, html }`

- Webview → Extension
  - `APPLY_EDIT`: `{ version, changes[] }`
  - `OPEN_LINK`: `{ href, fromUri }`
  - `REQUEST_PREVIEW`: `{ requestId, href, fromUri }`
  - `CREATE_ATTACHMENT`: `{ bytes, filenameHint, mime, fromUri }`

## 9. CSSカスタマイズ設計

## 9.1 方針

ユーザーCSSで見出しの色・サイズ・フォント・余白などを細かく制御できるよう、安定したクラスを付与する。
ユーザーCSSは複数指定でき、変更は自動反映する。

## 9.2 CSS適用順

- ベースCSS（拡張が提供）
- テーマCSS（拡張が提供、任意）
- ユーザーCSS（最後に適用、最優先）

## 9.3 主要クラス（安定API）

- `.md-heading`, `.md-h1`〜`.md-h6`
- `.md-paragraph`
- `.md-list`, `.md-list-item`
- `.md-blockquote`
- `.md-codeblock`, `.md-inline-code`
- `.md-bold`, `.md-italic`
- `.md-link`, `.md-link-destination`
- `.md-embed`, `.md-embed-image`

## 9.4 ユーザーCSSの例

```css
.md-heading.md-h1 {
  font-size: 2rem;
  margin: 1.2rem 0 0.6rem;
}
.md-heading.md-h2 {
  font-size: 1.6rem;
  margin: 1rem 0 0.5rem;
}
.md-heading.md-h3 {
  font-size: 1.3rem;
  margin: 0.9rem 0 0.4rem;
}

.md-link {
  text-decoration: underline;
}
.md-link-destination {
  opacity: 0.35;
}

.md-inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 0 0.25em;
  border-radius: 6px;
}

.md-embed-image img {
  max-width: 100%;
  border-radius: 10px;
}
```

## 9.5 CSSホットリロード

- `quench.css.files` に指定されたファイルを読み込む
- `FileSystemWatcher`で変更を検知し、Webviewへ再注入する
- 保存イベントで即時反映する設定も用意する

## 10. ワークスペース索引

- `.md`一覧を保持（QuickPick候補用）
- 見出し抽出は遅延
  - 「見出しリンク挿入」や「ホバープレビュー要求」が来たときに対象ファイルだけ解析

- 添付ファイル一覧（画像中心）
  - 画像挿入時に参照候補にもできる（将来）

## 11. 添付保存仕様

## 11.1 保存先ポリシー（設定）

- `workspaceRoot`
- `specifiedFolder`
- `sameFolder`
- `subfolder`

## 11.2 命名規則（設定）

- `timestamp`：`YYYYMMDD-HHmmss-<shortRandom>.<ext>`
- `noteNameTimestamp`：`<noteName>-YYYYMMDD-HHmmss.<ext>`

## 11.3 挿入形式

- 画像：`![](relative/path.ext)`
- それ以外：`[filename](relative/path.ext)`

## 12. セキュリティ

- Webview CSPを厳格化
- 外部画像ロードは既定OFF
- HTML埋め込みは既定OFF（ONにした場合も`iframe`は追加制限）

## 13. 設定項目（案）

- `quench.css.files`: string[]
- `quench.css.reloadOnSave`: boolean
- `quench.preview.syntaxVisibility`: `"smart" | "always" | "minimal"`
- `quench.links.previewOnHover`: boolean
- `quench.links.slugStyle`: `"github" | "raw" | "custom"`
- `quench.attachments.location`: `"workspaceRoot" | "specifiedFolder" | "sameFolder" | "subfolder"`
- `quench.attachments.folderPath`: string
- `quench.attachments.subfolderName`: string
- `quench.attachments.naming`: `"timestamp" | "noteNameTimestamp"`
- `quench.security.allowExternalImages`: boolean
- `quench.security.allowHtmlEmbeds`: boolean
- `quench.security.allowIframes`: boolean

## 14. コマンド（案）

- `Quench: Insert Markdown Link`
- `Quench: Insert Link to Heading`
- `Quench: Insert Image from File`
- `Quench: Paste Image as Attachment`
- `Quench: Insert Embed (Audio/Video/PDF)`
- `Quench: Reload CSS`
- `Quench: Rebuild Workspace Index`

## 15. パフォーマンス設計

- 表示範囲中心のデコレーション更新
- 見出し解析・プレビュー生成は必要時に限定
- 画像サムネイルは遅延ロードとキャッシュ
- 大きい添付の貼り付けはサイズ上限を設定可能にする

## 16. テスト観点

- リンク挿入
  - 相対パス生成、アンカー生成、見出し抽出

- 添付保存
  - 保存先ポリシー、命名衝突、相対パス計算、貼り付け/ドロップ経路

- Live Preview
  - 見出しやリンクにクラスが付与され、ユーザーCSSが確実に効く
  - カーソル周辺の記号可視化が破綻しない

- セキュリティ
  - 外部画像/HTML埋め込み無効時に読み込まれない

- 同期
  - Undo/Redo、外部変更反映、複数エディタグループでの整合性

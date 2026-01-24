# Quench Markdown Editor（VSCode拡張）詳細設計

本書は `docs/master.md` を実装可能な粒度に落とすための詳細設計である。  
設計の前提は「保存される内容は純Markdown」「編集体験はLive Previewのみ」「リンクはMarkdown linkのみ」「ユーザーCSSで見た目を制御」「貼り付け/ドロップで画像添付を自動化」。

---

## 1. 技術選定（確定）

### 1.1 VSCode側
- 実装方式: `CustomTextEditorProvider`（Custom Editor）
- 言語: TypeScript
- ファイルI/O: `vscode.workspace.fs`（Remote/WSL/SSH対応を優先）
- ワークスペース索引: `workspace.findFiles` + `FileSystemWatcher`

### 1.2 Webview側
- エディタ: CodeMirror 6
- Live Preview表現: CodeMirrorの`Decoration`（mark / replace / widget）で「クラス付与」「薄表示」を実現
- 表示カスタマイズ: `<style nonce>` にCSSを注入（ベース→テーマ→ユーザーCSSの順）

### 1.3 Markdown解析（用途別）
- 見出し抽出/アンカー生成（Extension側）: `markdown-it` + heading token 抽出（または remark 系）
- アンカー（GitHub風）の実装: `github-slugger` を第一候補（重複番号付与込み）

> 注: `quench.links.slugStyle` の `raw/custom` は仕様が未確定のため、挙動は「要判断」として本書末尾に残す（推測で確定しない）。

---

## 2. 拡張機能の外部仕様（VSCode）

### 2.1 contributes（package.json）
- `customEditors`
  - `viewType`: `quench.markdownEditor`
  - `selector`: `[{ "filenamePattern": "*.md" }]`
  - `priority`: `"option"`（ユーザーが明示的に選べる）
- `commands`（`docs/master.md` の案を踏襲）
- `configuration`（`docs/master.md` の案を踏襲）

### 2.2 activationEvents
- `onCustomEditor:quench.markdownEditor`
- `onCommand:quench.insertMarkdownLink` 等（各コマンド分）

### 2.3 コマンドID（例）
表示名は `Quench: ...` とし、内部IDは `quench.*` で統一する。
- `quench.insertMarkdownLink`
- `quench.insertLinkToHeading`
- `quench.insertImageFromFile`
- `quench.pasteImageAsAttachment`
- `quench.insertEmbed`
- `quench.reloadCss`
- `quench.rebuildWorkspaceIndex`

---

## 3. モジュール構成（Extension Host）

`src/extension` 配下を想定。依存方向は「Provider → Services」で一方向にする。

### 3.1 QuenchEditorProvider（CustomTextEditorProvider）
責務:
- `.md` を Webview に表示（Live Preview専用）
- TextDocument と Webview の同期（Undo/Redo整合性を最優先）
- クリック/ホバー等のユーザー操作を Extension の機能に接続

主要API:
- `resolveCustomTextEditor(document, panel, token)`
- `panel.webview.onDidReceiveMessage(...)`
- `workspace.onDidChangeTextDocument(...)`（当該documentのみ）

### 3.2 WorkspaceIndex
責務:
- ワークスペース内 `.md` の一覧を保持（QuickPick候補）
- ファイル作成/削除/リネームの追跡
- 見出し抽出は「必要時に対象ファイルだけ」（遅延）

I/F:
- `getMarkdownFiles(): Promise<Uri[]>`
- `getHeadings(uri): Promise<Heading[]>`（キャッシュは任意。破棄ルールは明示する）

### 3.3 LinkService
責務:
- 相対パス生成（現在ノートの位置基準）
- `file.md#anchor` 形式の生成
- `OPEN_LINK` の解決（workspace内優先）

主要仕様:
- 相対パスは「編集中のノートのディレクトリ」を基準に `../` を含み得る。
- workspace外のリンクは、VSCodeの既定挙動に委譲（外部は `env.openExternal`、fileは `openTextDocument` 等）。

### 3.4 AttachmentService
責務:
- 画像貼り付け/ドロップで受け取ったbytesを保存
- 保存先ポリシー（`quench.attachments.location`）の適用
- 命名規則（`quench.attachments.naming`）の適用
- Markdownへの挿入文字列の生成（画像 `![](...)` / その他 `[name](...)`）

衝突/失敗時の方針（フォールバック抑制）:
- 既定の命名で既存ファイルと衝突した場合:
  - `timestamp` は `<shortRandom>` を含むため通常は衝突しないが、衝突した場合は **エラーとしてユーザーに通知** し、保存は行わない（サイレント再試行はしない）。
  - 仕様として「衝突時は連番付与で再試行」を採る場合は、設定または仕様に明文化した上で実装する（要判断）。

### 3.5 CssService
責務:
- `quench.css.files` の読み込み（複数）
- `FileSystemWatcher` で変更検知し `CSS_UPDATED` 送信
- `quench.css.reloadOnSave` がONの場合は保存イベントで再注入

失敗時:
- 読み込み不能なCSSは **エラーを通知**（ステータスバー/通知）し、該当ファイルは未適用のままにする（勝手に別CSSへフォールバックしない）。

### 3.6 SecurityPolicy
責務:
- Webview HTMLのCSP生成
- `allowExternalImages / allowHtmlEmbeds / allowIframes` の適用

基本方針:
- 既定で外部ロード禁止（画像/iframe）
- Webview側でDOMを触る場合も nonce を使用し、`style-src` は nonce 制約を基本とする

---

## 4. Webview UI（CodeMirror 6）詳細

`src/webview` 配下を想定。

### 4.1 画面構成
- ルート: 1カラムの編集領域（CodeMirror）
- 付随UI（オプション）:
  - リンクホバーのプレビューカード（設定ON時のみ）
  - 添付保存中のインジケータ（必要なら）

### 4.2 Live Previewの実現方針
「HTMLへ完全変換して表示」ではなく、**CodeMirrorの表示レイヤで見た目を整える**。

対象（MVP）:
- 見出し: `#` 記号を薄くする／テキストは `.md-heading` + `.md-hN`
- 太字/斜体: `**` / `*` 記号を薄く、本文に `.md-bold` / `.md-italic`
- インラインコード: バッククォートを薄く、本文に `.md-inline-code`
- リンク: ラベルとURLの範囲を分けて `.md-link` / `.md-link-destination` を付与
- 画像: `![](...)` を検出し、サムネイルwidget（`.md-embed-image`）を挿入

`quench.preview.syntaxVisibility`:
- `smart`: カーソル（selection）を含む構文記号は通常表示、外は薄表示
- `always`: 常に通常表示（薄表示しない）
- `minimal`: 常に薄表示（ただし不可視化はしない。カーソル位置の破綻回避のため）

### 4.3 パフォーマンス
- デコレーション更新は `view.visibleRanges` を中心に行い、全量再計算を避ける
- 大きいファイルでは、viewport外は「未計算（装飾なし）」を許容する（表示破綻より性能を優先）

### 4.4 画像貼り付け/ドロップ
- paste: `ClipboardEvent.clipboardData.items` から画像を抽出し `ArrayBuffer` 化して `CREATE_ATTACHMENT` を送る
- drop:
  - OSファイル: `DataTransferItem.getAsFile()` でbytes送信
  - ワークスペース内ファイル: `text/uri-list` 等を受け、既定は参照リンク（設定で「コピーして添付化」も可能）

---

## 5. ドキュメント同期（最重要）

### 5.1 基本原則
- 真実のソースは `TextDocument`
- Webviewの編集は必ず `WorkspaceEdit` として適用し、Undo/RedoをVSCode標準に統合する
- 競合時は推測でマージしない（問題を露呈させる）

### 5.2 バージョン整合性
- Webviewは「自分が認識するdocument version」を持つ
- `APPLY_EDIT` には `baseVersion` を必須で付ける
- Extension側で `document.version !== baseVersion` の場合:
  - **編集は適用しない**
  - Webviewへ `DOC_RESYNC`（全文 + 正しいversion）を返す

### 5.3 パッチ表現（推奨）
VSCodeの `TextDocumentContentChangeEvent` 互換の差分を採用する。
- `rangeOffset: number`
- `rangeLength: number`
- `text: string`

適用順序:
- Extension側で複数changesを適用する場合、`rangeOffset` 降順で `WorkspaceEdit.replace` を組み立てる（位置ずれ防止）。

---

## 6. メッセージプロトコル（詳細）

型検証:
- Webview/Extension双方で受信メッセージをランタイム検証し、無効なメッセージは **例外としてログに残して破棄** する（握りつぶさない）。

### 6.1 Extension → Webview
- `INIT`: `{ documentUri, text, version, settings, cssText[] }`
- `REQUEST_SELECTION`: `{ requestId }`
- `DOC_PATCH`: `{ version, changes[] }`
- `DOC_RESYNC`: `{ text, version, reason }`
- `CSS_UPDATED`: `{ cssText[] }`
- `APPLY_EDIT_RESULT`: `{ requestId, applied, version, error? }`
- `PREVIEW_RESULT`: `{ requestId, title, text }`
- `RESOURCE_URI_RESULT`: `{ requestId, ok, uri?, error? }`
- `CREATE_ATTACHMENT_RESULT`: `{ requestId, ok, error? }`
- `ERROR`: `{ message, detail? }`

### 6.2 Webview → Extension
- `APPLY_EDIT`: `{ requestId, baseVersion, changes[] }`
- `REQUEST_DOC_RESYNC`: `{}`
- `SELECTION_RESULT`: `{ requestId, baseVersion, selectionFrom, selectionTo, selectedText }`
- `OPEN_LINK`: `{ href, fromUri }`
- `REQUEST_PREVIEW`: `{ requestId, href, fromUri }`
- `REQUEST_RESOURCE_URI`: `{ requestId, href, fromUri, kind:"image" }`
- `CREATE_ATTACHMENT`: `{ requestId, baseVersion, fromUri, insertFrom, insertTo, bytes, filenameHint?, mime?, kind:"image" }`
- `INSERT_IMAGE_REFERENCE`: `{ requestId, baseVersion, fromUri, insertFrom, insertTo, targetUri }`

---

## 7. 主要ユースケース（シーケンス）

### 7.1 編集
1. Webviewで入力 → `APPLY_EDIT(requestId, baseVersion, changes)`
2. Extensionでversion一致確認 → `WorkspaceEdit` 適用
3. `onDidChangeTextDocument` → 発信元Webviewへ `APPLY_EDIT_RESULT(requestId, applied=true, newVersion)`（他のエディタ/パネルへは `DOC_PATCH`）

version不一致時:
- Extensionは `APPLY_EDIT_RESULT(applied=false, error=version_mismatch)` と `DOC_RESYNC(reason=version_mismatch)` を返し、Webviewは全文置換する（勝手にマージしない）。

### 7.2 リンクCtrl/Cmd+クリック
1. Webviewがリンクrangeを判定し `OPEN_LINK(href, fromUri)`
2. Extensionがworkspace内パスを解決し `openTextDocument` / `showTextDocument`
3. `#anchor` があれば対象ファイルの見出し解析 → 行へ `revealRange`

### 7.3 画像貼り付け
1. Webviewでpaste検知 → 画像bytes抽出 → `CREATE_ATTACHMENT(...)`
2. Extensionが保存先/命名を決定して `workspace.fs.writeFile`
3. Extensionが Markdown挿入の `WorkspaceEdit` を適用（カーソル位置はWebview側からrange指定が必要）

> 注: 「どこに挿入するか（カーソル位置）」の同期仕様が必要。MVPでは「Webviewが挿入位置rangeを送る」方式を推奨（要実装仕様化）。

---

## 8. 設定（最小スキーマ）

`docs/master.md` の案をそのまま採用し、MVPでは以下を必須対応とする。
- `quench.css.files`
- `quench.css.reloadOnSave`
- `quench.preview.syntaxVisibility`
- `quench.links.previewOnHover`
- `quench.links.slugStyle`（`github`のみ確定、他は要判断）
- `quench.attachments.location`
- `quench.attachments.folderPath`
- `quench.attachments.subfolderName`
- `quench.attachments.naming`
- `quench.security.allowExternalImages`
- `quench.security.allowHtmlEmbeds`
- `quench.security.allowIframes`

---

## 9. セキュリティ要件（実装チェックリスト）

- Webview CSP
  - `default-src 'none'`
  - `img-src` は `webview.cspSource` のみ（外部画像OFF時）
  - `style-src` は nonce 制約
  - `script-src` は nonce 制約
- `allowExternalImages=false` の場合、Webviewで `http(s)` の画像URLを表示しない（サムネイルwidget生成を抑止）
- `allowHtmlEmbeds=false` の場合、HTMLスニペットは表示上「テキスト扱い」を維持（勝手にレンダリングしない）

---

## 10. 未確定事項（要判断）

1) `quench.links.slugStyle` の `raw/custom` の定義  
2) 添付ファイル命名衝突時の扱い（エラーで止める / 連番で再試行 / 再生成する）  
3) 画像挿入時の「挿入位置range」仕様（Webview主導でrange送信するか、Extensionでselection取得するか）  
4) `customEditors.priority`（当面 `"option"` で固定。`"default"` は別途判断）  
5) HTML embed（audio/video/pdf）のMVP範囲（表示widgetまでやるか、挿入のみか）

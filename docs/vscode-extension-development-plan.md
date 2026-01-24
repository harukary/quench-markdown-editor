# Quench Markdown Editor（VSCode拡張）開発計画

本計画は `docs/master.md` と `docs/vscode-extension-detail-design.md` を前提に、MVP→拡張の順で段階的に完成させるための作業分解である。

---

## 0. 前提・進め方

- 「Live Preview専用（Source mode/Reading viewは提供しない）」を守る
- 保存される内容は純Markdown（サイズ指定などの独自記法を埋め込まない）
- 競合や不整合は推測で隠さず、`DOC_RESYNC` 等で明示的に整合を取り直す
- Remote/WSL/SSHを破壊しない（`workspace.fs` 基本）
- Custom Editor の優先度は当面 `"option"`（既存Markdown体験への影響を最小化）

---

## 1. マイルストーン（MVP→拡張）

### M1: 拡張の骨組み（最短で起動・表示）
成果物:
- Custom Editorとして `.md` を開ける（空のWebviewでOK）
- Webviewへ `INIT(text, version, settings, css)` が届く

作業:
- VSCode拡張スキャフォールド（TypeScript）
- `customEditors` / `commands` / `configuration` の雛形
- `QuenchEditorProvider` の登録
- Webview HTML（CSP/nonce含む）の確立

DoD:
- ローカルで `F5` 実行し、`.md` をQuenchで開ける
- CSP違反がコンソールに出ない（最低限）

---

### M2: ドキュメント同期（Undo/Redo整合性）
成果物:
- Webview入力 → `WorkspaceEdit` → `TextDocument` 更新 → Webviewへ `DOC_PATCH` 返送
- version不一致時に `DOC_RESYNC` が動く（サイレントマージしない）

作業:
- メッセージ型の共有（`src/shared/protocol`）
- `APPLY_EDIT`（rangeOffset/rangeLength/text）適用（降順適用）
- `workspace.onDidChangeTextDocument` を監視してWebviewへ差分送信

DoD:
- Undo/RedoでWebview表示と文書が一致する
- 外部変更（他エディタで編集/保存）もWebviewに反映される

---

### M3: Live Preview（基本クラス付与 + syntaxVisibility）
成果物:
- 見出し/リンク/強調/インラインコード等に安定クラスが付与される
- `syntaxVisibility`（smart/always/minimal）の挙動が成立する（不可視化はしない）

作業:
- CodeMirror 6 + Markdown language導入
- Decoration plugin（visibleRanges中心）実装
- `.md-...` クラスとベースCSSの追加

DoD:
- `docs/master.md` のCSS例を適用すると見た目が変わる
- 大きめのMarkdownでも操作が極端に重くならない（体感確認）

---

### M4: ユーザーCSS読み込みとホットリロード
成果物:
- `quench.css.files` のCSSを読み込み、Webviewへ注入
- `FileSystemWatcher` で変更を検知し即反映（`CSS_UPDATED`）

作業:
- CssService実装（読み込み・監視）
- Webview側の `<style>` 差し替え実装（nonce維持）

DoD:
- CSS保存だけで見た目が更新される（reload不要）
- 読めないCSSは通知され、勝手に無視しない

---

### M5: Markdown link 挿入（ファイル/見出し）
成果物:
- `Quench: Insert Markdown Link`（QuickPickで`.md`選択→相対パス挿入）
- `Quench: Insert Link to Heading`（対象ノートの見出し一覧→`#anchor`挿入）

作業:
- WorkspaceIndex（`.md`一覧）
- LinkService（相対パス、アンカー生成）
- 見出し抽出（対象ファイルのみ遅延）
- コマンド実装（挿入位置: VSCode側selectionを使う/もしくはWebviewに指示）

DoD:
- 既存Markdownを壊さず、常に `[label](relative/path.md)` を挿入できる

---

### M6: リンク操作（Ctrl/Cmd+クリック + ホバー任意）
成果物:
- Ctrl/Cmd+クリックでリンク先を開く（workspace内優先）
- `previewOnHover` ONでホバープレビュー（簡易）

作業:
- Webviewでクリック/修飾キー判定 → `OPEN_LINK`
- Extensionでリンク解決（file/fragment）
- プレビュー: `REQUEST_PREVIEW` → Extensionで読み込み→（必要なら）Markdown→HTML→返却
- セキュリティ: 外部画像/HTML embedの既定ブロックを適用

DoD:
- ファイルリンクが正しく遷移し、`#anchor` も可能な範囲で追従する

---

### M7: 画像貼り付け/ドロップ → 添付保存 → 埋め込み挿入
成果物:
- paste/dropで画像を添付保存し `![](relative/path.png)` を挿入
- 保存先ポリシー/命名規則の設定が効く
- Live Previewでサムネイルwidgetが見える（遅延ロード）

作業:
- Webviewでpaste/drop bytes取得
- AttachmentServiceで保存（`workspace.fs.writeFile`）
- 挿入位置仕様を確定（要判断事項を決めてから実装）

DoD:
- ワークスペース外ファイルのdropでも「コピーして添付化」ができる
- 外部画像許可OFF時に外部URLが勝手に表示されない

---

### M8: セキュリティ/パフォーマンス仕上げ
成果物:
- CSP/外部ロード制御が仕様通り
- 大きいMarkdownでのデコレーション更新が破綻しにくい

作業:
- Webviewのresource URL管理（`asWebviewUri`）
- 画像サムネイルのキャッシュ/遅延戦略
- 計測ログ（開発時のみ）とボトルネック潰し

DoD:
- 設定OFFの機能（外部画像/HTML embed）が確実に無効化される

---

### M9: テスト・CI・リリース準備
成果物:
- ユニットテスト（Link/Attachment/Slug/Path）
- 最低限のE2E（起動してcustom editorが開く）
- `vsce` でパッケージングできる

作業:
- テスト基盤（mocha/vitestの選定）
- `@vscode/test-electron` の導入（必要範囲のみ）
- CI（GitHub Actions等）の雛形（必要なら）

DoD:
- 主要なサービスがテストで担保される
- `vsix` を生成してインストールできる

---

## 2. 初期スプリント（おすすめ順）

1) M1（骨組み）  
2) M2（同期）  
3) M3（Live Preview最小）  
4) M4（CSSホットリロード）  
5) M5（リンク挿入）  
6) M7（画像添付）  
7) M6（プレビュー）  
8) M8（仕上げ）  
9) M9（テスト/リリース）

---

## 3. リスクと対策（設計レベル）

- 同期の複雑化（versionズレ/二重適用）
  - 対策: `baseVersion` 必須、ズレたら `DOC_RESYNC`（推測マージしない）
- Live Previewの「不可視化」によるカーソル崩壊
  - 対策: `display:none` 等は使わず、薄表示（opacity/color）に限定
- 画像貼り付けのバイナリ処理（サイズ/メモリ）
  - 対策: サイズ上限設定（`docs/master.md` の方針）をMVPから入れるか検討（要判断）
- VSCode既存Markdown体験との衝突
  - 対策: custom editorは当面 `"option"` 優先度で提供し、ユーザーが明示選択できる形から開始

---

## 4. 要判断（着手前に決める）

- `slugStyle` の `raw/custom` 定義
- 添付命名衝突時の扱い（エラー/連番/再生成）
- 画像挿入位置仕様（Webviewがrange送信する方式を採るか）
- HTML embed（audio/video/pdf）をMVPに入れるか（挿入のみ/表示まで）

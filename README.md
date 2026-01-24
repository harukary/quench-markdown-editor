# Quench Markdown Editor

VSCode上でMarkdownを「Custom Editor（Webview）」として開き、Live Preview前提で編集するための拡張の土台です。

## いま入っているもの（最小）

- Custom Editor `quench.markdownEditor`（優先度: option）
- Webview内のCodeMirror 6で編集
- `TextDocument` へ `WorkspaceEdit` で反映（Undo/RedoはVSCode標準）
- `quench.css.files` のCSSをWebviewへ注入 + 変更検知で再注入
- コマンド `Quench: Reload CSS`（`quench.reloadCss`）

## 開発手順

1) 依存を入れる

```bash
npm install
```

2) ビルドする（Webview bundle + Extension compile）

```bash
npm run build
```

3) VSCodeでこのフォルダを開き、`F5` で拡張ホストを起動する

4) `.md` を開いて、エディタ右上の「Open With...」から `Quench Markdown Editor` を選ぶ

## 設定

- `quench.css.files`: ワークスペースルート相対のCSSパス配列
- `quench.css.reloadOnSave`: 保存時に再注入（watcherがあるので補助的）

詳細は `docs/master.md` を参照。


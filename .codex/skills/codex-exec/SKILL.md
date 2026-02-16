---
name: codex-exec
description: 非対話の `codex exec` を安全に運用し、調査・実装・レビュー・発散探索を小さなジョブに分割して実行する。評価関数が未定義/定義困難なタスク（UIの目視評価、UX文面、創造案比較）で複数案を出し、人間が収束判断する必要があるときに使う。
---

# codex-exec

## 概要

`codex exec` を「1回で全部やる」のではなく、役割ごとに分割して回すためのスキル。
特に、正解を機械判定しづらいタスクで、探索を広げて比較しやすくする。

## 運用原則

1. 目的を1ジョブ1目的に限定する。
2. 出力契約を先に決める（JSONスキーマ推奨）。
3. 調査は `read-only`、編集は必要時のみ `workspace-write` にする。
4. 長時間ジョブは `tmux` で回す。
5. 探索と収束を分離する。収束判断はユーザーが行う。

## 実行フロー

1. タスク分類を決める。
2. `references/` のテンプレを選ぶ。
3. 必要な `scope`（期間/対象/件数）を明示する。
4. `codex exec` を実行する。
5. 結果を統合し、次アクションを決める。

## タスク分類

- 調査・履歴収集: `references/template-research.md`
- 実装・編集: `references/template-implement.md`
- レビュー: `references/template-review.md`
- 発散探索（評価関数なし）: `references/template-explore-qualitative.md`

## 実行コマンド例

### 調査（安全）

```bash
codex exec -s read-only --skip-git-repo-check \
  -C /ABS/PATH/TO/REPO \
  - < prompt.txt
```

### JSON契約あり（推奨）

```bash
codex exec -s read-only --skip-git-repo-check \
  --output-schema schema.json \
  -o result.json \
  -C /ABS/PATH/TO/REPO \
  - < prompt.txt
```

### 編集を伴う実装

```bash
codex exec -s workspace-write \
  -C /ABS/PATH/TO/REPO \
  - < prompt.txt
```

## 評価関数がないタスクでのコツ

1. 3〜7案を同時に出す。
2. 暫定rubricを先に固定する（例: 明快さ/一貫性/実装容易性/違和感）。
3. 画像は `view_image` で比較し、理由を短く記録する。
4. 採用理由を1〜3行で残し、次サイクルの条件に反映する。

## `tmux` 推奨パターン

```bash
tmux -L codex -f ~/workspace/agents/skills/tmux/tmux.codex.conf \
  new-session -d -s execjob -n run -c "$PWD" \
  "bash -lc 'codex exec -s read-only -C \"$PWD\" - < prompt.txt'"
```

進捗確認:

```bash
tmux -L codex capture-pane -pt execjob:run | tail -n 80
```

## 失敗時の切り分け

1. 出力が収束しない: プロンプトを短くし、目的を分割する。
2. JSONが壊れる: `--output-schema` を使い、最終応答の制約を厳格化する。
3. 探索が広すぎる: `scope`（期間/対象/件数）を明示する。
4. 実行が長い: `tmux` に移してログを継続観測する。

## 参照テンプレ

- `references/template-research.md`
- `references/template-implement.md`
- `references/template-review.md`
- `references/template-explore-qualitative.md`
- `references/template-schema-min.json`


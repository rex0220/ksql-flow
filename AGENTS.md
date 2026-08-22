# AGENTS.md — kSQL Flow 開発エージェント向け案内

このリポジトリは複数の AI エージェントが役割分担で開発しています。**自分の役割の指示書を最初に読むこと。**

| 役割 | 担当 | 指示書 |
| --- | --- | --- |
| 仕様レビュー | Codex | `docs/internal/flow_spec_review_task.md` |
| ランナー実装 | Codex | `docs/internal/flow_runner_task.md` |
| コードレビュー | Claude Code | `docs/internal/flow_code_review_task.md` |

共通の前提:

* 仕様の正は `docs/ksql_flow_design_v2_8.md`。エンジン側の事実関係は `docs/internal/kSQLエンジンからの申し送り-20260822-v3710.md`。
* エンジンリポジトリ `../kintone-sql-tools` は**変更禁止**（依頼は文書で起票）。依存は公式 API `@rex0220/kintone-sql-tools/flow` のみ。
* MIT ライセンス・テレメトリなし・外部通信は設定された kintone と Webhook のみ。認証情報をログに出さない。
* 役割間の意見の相違は裁定者 Takashi に上げ、結果を `docs/internal/reviews/decisions.md` に記録する。裁定済み事項は再提案しない。

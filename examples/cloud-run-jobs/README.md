# Google Cloud Run Jobs で毎朝動かす

> **状態: 実機検証済み（2026-08-28）。** 本 README の一連のコマンド（ビルド → Secret 注入 → ジョブ作成 → 手動実行 → Scheduler 発火）は GCP 実機で検証済みです。検証の詳細は解説記事 [【kSQL Flow #12】kintone バッチを Cloud Run Jobs へ](https://qiita.com/rex0220/items/3c3d49419f91e582d1ab) を参照してください。

Cloud Run Jobs は「コンテナを 1 回実行して終了する」ためのマネージド実行環境です。サーバーの保守（パッチ・再起動・死活監視）が不要で、実行した秒数だけ課金されます。kSQL Flow は**実行環境が使い捨てでも壊れない**よう設計されています — 実行履歴・分散ロック・resume の正はすべて kintone のログアプリにあるためです。

## 前提

- GCP プロジェクト（例では `PROJECT_ID`。実際の ID に読み替え）
- リージョンは `asia-northeast1`（東京）
- `gcloud` CLI 認証済み・課金有効

## 1. イメージのビルドと登録（Artifact Registry + Cloud Build）

ジョブリポジトリ（`jobs/` と `ksql.config.json` があるディレクトリ）にこの `Dockerfile` を置いて:

```bash
# 初回のみ: Docker リポジトリ作成
gcloud artifacts repositories create ksql \
  --repository-format=docker --location=asia-northeast1

# ビルドして push（ローカル Docker 不要 — Cloud Build がリモートでビルド）
gcloud builds submit \
  --tag asia-northeast1-docker.pkg.dev/PROJECT_ID/ksql/ksql-flow-batch:latest
```

## 2. 認証情報を Secret Manager へ

API トークンはイメージにもジョブ定義にも直書きせず、Secret Manager から環境変数として注入します。

```bash
printf '%s' '実際のトークン値' | gcloud secrets create KSQL_TOKEN_ORDERS --data-file=-
printf '%s' '実際のトークン値' | gcloud secrets create KSQL_TOKEN_LOGS   --data-file=-
# 実行サービスアカウントに閲覧権を付与
gcloud secrets add-iam-policy-binding KSQL_TOKEN_ORDERS \
  --member="serviceAccount:SA_EMAIL" --role="roles/secretmanager.secretAccessor"
```

## 3. ジョブの作成

```bash
gcloud run jobs create ksql-daily-batch \
  --image asia-northeast1-docker.pkg.dev/PROJECT_ID/ksql/ksql-flow-batch:latest \
  --region asia-northeast1 \
  --tasks 1 --parallelism 1 \
  --max-retries 0 \
  --task-timeout 3600 \
  --memory 1Gi \
  --service-account SA_EMAIL \
  --set-secrets "KSQL_TOKEN_ORDERS=KSQL_TOKEN_ORDERS:latest,KSQL_TOKEN_LOGS=KSQL_TOKEN_LOGS:latest"
```

設定の意図:

- **`--service-account` は必須と考えてください**（実機で確認）。省略すると既定の Compute Engine サービスアカウントで動くため、§2 で実行 SA に付けた Secret 読取権が使われず、権限設計が崩れます。

- **`--max-retries 0`** — 失敗時の自動リトライはさせません。kSQL Flow の失敗は Exit Code で分類されており、機械的な再実行が安全とは限らないためです（リランは下記の `--resume` で明示的に）。
- **`--task-timeout`** は `ksql.config.json` の `batchTimeoutSec` **以上**にします。逆にすると、ロックの stale 回収より先にコンテナが打ち切られます。
- **`--tasks 1 --parallelism 1`** — 分散実行はしません。多重起動の抑止はログアプリの分散ロック（`job_key`）が担います。

手動実行:

```bash
gcloud run jobs execute ksql-daily-batch --region asia-northeast1 --wait
```

デプロイ後の疎通確認は、書込のない `validate` を引数上書きで実行するのが安全です（実機確認済み。**先頭に `ksql-flow` を含める**こと — このイメージは ENTRYPOINT を持たないため、`--args` は CMD 全体を置き換えます）:

```bash
gcloud run jobs execute ksql-daily-batch --region asia-northeast1 --wait \
  --args="ksql-flow,validate,--profile,prod,--check-logapp"
```

## 4. Cloud Scheduler で毎朝起動

```bash
gcloud scheduler jobs create http ksql-daily-batch-trigger \
  --location asia-northeast1 \
  --schedule "0 6 * * *" --time-zone "Asia/Tokyo" \
  --uri "https://run.googleapis.com/v2/projects/PROJECT_ID/locations/asia-northeast1/jobs/ksql-daily-batch:run" \
  --http-method POST \
  --oauth-service-account-email SA_EMAIL \
  --max-retry-attempts 0
```

- サービスアカウント `SA_EMAIL` にはジョブへの `roles/run.invoker` が必要です。
- **`--max-retry-attempts 0`** — スケジューラ側のリトライも 0 にします（上と同じ理由）。
- スケジューラの**二重発火は仕様として起こり得ます**。kSQL Flow 側は分散ロックにより後発が Exit 5 で安全にスキップするため、二重に書き込まれることはありません。

## 使い捨て環境での注意

- **コンテナのファイルシステムは揮発します**（Cloud Run の書込先はインメモリで、メモリ使用量に算入されます）。`cwd/.ksql`（ローカルロック・ローカル JSONL・state）は実行ごとに消えますが、排他・実行履歴・resume の正は**ログアプリ側**にあるため運用は成立します。ローカル JSONL 退避（ログアプリへの書込失敗時の救済）だけは実行終了とともに失われる点は許容してください。
- **Exit 5（多重起動スキップ）も GCP コンソール上は「失敗した実行」に見えます**（非 0 の Exit Code のため）。実行結果の監視は GCP の実行ステータスではなく、ログアプリの status と条件通知を正としてください。
- リラン（`--resume`）は、コンテナ引数を上書きして実行します:

```bash
gcloud run jobs execute ksql-daily-batch --region asia-northeast1 --wait \
  --args="run-all,./jobs/,--profile,prod,--resume"
```

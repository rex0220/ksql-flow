# Google Cloud Run Jobs 用（examples/docker と同一 — ベースイメージはリポジトリの docker 例を参照）
FROM node:22-slim
RUN npm i -g @rex0220/ksql-flow
WORKDIR /app
COPY jobs/ ./jobs/
COPY ksql.config.json .
# 認証情報はイメージに焼かない — Secret Manager から環境変数で注入する（README 参照）
CMD ["ksql-flow", "run-all", "./jobs/", "--profile", "prod"]

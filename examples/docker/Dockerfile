# 設計書 付録 A-4: Docker
FROM node:22-slim
RUN npm i -g @rex0220/ksql-flow
WORKDIR /app
COPY jobs/ ./jobs/
COPY ksql.config.json .
CMD ["ksql-flow", "run-all", "./jobs/", "--profile", "prod"]

FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
# 业务服务默认 4318；内置拉起的本地收单方默认 4317。
EXPOSE 4318 4317
# 默认启动业务服务（自动内置本地收单方）。
# 仅运行收单方时改用：npm run start:partner
CMD ["npm", "run", "start"]

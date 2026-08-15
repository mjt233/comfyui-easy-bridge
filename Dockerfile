# syntax=docker/dockerfile:1

# ============================================================
# 构建阶段：安装依赖并编译 server（tsc）与 client（vite）
# node:24-bookworm（非 slim）自带 python3 / make / g++，
# 可编译 better-sqlite3 等原生模块（无预编译产物时兜底）
# ============================================================
FROM node:24-bookworm AS build

WORKDIR /workspace

# 启用 corepack 并固定 pnpm 9（与 pnpm-lock.yaml v9 匹配）；
# corepack 下载的 pnpm 本体缓存在 /corepack，避免每次构建重复下载
ENV COREPACK_HOME=/corepack
RUN --mount=type=cache,id=corepack,target=/corepack \
    corepack enable && corepack prepare pnpm@9 --activate

# 先只拷贝清单文件，利用 Docker 层缓存复用依赖安装
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json

# 将 pnpm store 重定向到缓存挂载点（项目级 .npmrc，对后续所有 pnpm 命令生效），
# 配合下方 --mount 实现跨构建的依赖缓存
RUN echo "store-dir=/pnpm-store" > .npmrc

# --mount=type=cache：pnpm store 保存在构建缓存中，
# 仅当 package.json / pnpm-lock.yaml 变化时增量下载新依赖
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile

# 拷贝源码并构建后端 + 前端
COPY packages/server packages/server
COPY packages/client packages/client
RUN pnpm --filter server build
RUN pnpm --filter client build

# 产出仅含生产依赖的 server 部署目录（pnpm deploy 自动裁剪 devDependencies），
# 并显式拷入编译产物 dist（避免依赖 pnpm deploy 的打包忽略规则）；
# --legacy：pnpm 9.15+ / 10+ 默认要求 inject-workspace-packages=true，
#   本工作区未开启该选项，故用旧版部署行为（不注入 workspace 包，仅打包本包 + 生产依赖）；
# deploy 同样挂载 store 缓存，避免重复下载
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm --filter server deploy --legacy --prod /out/server \
    && cp -r packages/server/dist /out/server/dist

# ============================================================
# 运行阶段：最小运行时镜像（glibc 与构建阶段一致，原生模块可直接运行）
# ============================================================
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=10721 \
    DATA_DIR=/app/data \
    CLIENT_DIST=/app/client/dist

WORKDIR /app

# 后端产物 + 生产依赖
COPY --from=build /out/server /app
# 前端构建产物（由后端 Express 静态托管）
COPY --from=build /workspace/packages/client/dist /app/client/dist

EXPOSE 10721

# 健康检查：命中 /api/health 即认为存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 10721) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

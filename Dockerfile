# 多阶段构建：依赖 → 编译 → 运行。运行层只带生产依赖，且以非 root 用户启动。
#
# 注意：运行的是 `tsc` 编译产物（dist/），不是源码直跑。
# 这样运行层不需要 tsx / typescript，镜像更小；代价是改了代码要重新 build。
#
# 关于 `public/` 的位置：`server.ts` 用 `resolve(__dirname, "../../public")` 找静态目录，
# 编译后 __dirname 是 /app/dist/server，所以 public 必须放在 /app/public（与 dist 同级）。

# ---------- 1. 生产依赖 ----------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 只装运行时依赖：zod、zod-to-json-schema、@modelcontextprotocol/sdk。
# 语义检索的两个包（@lancedb/lancedb、@huggingface/transformers）是 optionalDependencies，
# 容器里默认用不到（后端是 lexical，镜像内也没有 380 MB 模型权重）。
# 想要更小的镜像，把下面这行换成：npm ci --omit=dev --omit=optional
#   ⚠️ 只能加在这一层（运行层）：下面的 build 阶段要编译 TS，而 vector.ts 的类型导入
#      需要该包存在（缺包时 tsc 报 TS2307），所以编译环境必须装齐。
RUN npm ci --omit=dev

# ---------- 2. 编译 ----------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- 3. 运行 ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node skills ./skills

# 运行期需要写入的目录（挂载卷时宿主目录需对 uid 1000 可写）
RUN mkdir -p workspace traces history memory vector-db checkpoints \
    && chown -R node:node workspace traces history memory vector-db checkpoints

# 非 root 运行（node 镜像内置 uid 1000 的 node 用户）
USER node

EXPOSE 3000

# 用 /health 而非 TCP 探活：端口开着不代表依赖都装配好了
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "dist/server/server.js"]

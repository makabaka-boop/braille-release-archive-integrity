# ---- 构建阶段：纯静态单页应用 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行阶段：web 仅提供静态文件 ----
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

# ---- 一次性验收阶段：单元测试 + 构建 + Playwright 端到端 ----
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS verify
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
# 浏览器已由 Playwright 基础镜像预装；依次执行单元测试、类型检查构建、E2E。
# 先在后台启动 preview 并等待 4173 就绪，再运行 Playwright（CI 模式下配置不自带 webServer）。
CMD ["sh", "-c", "npm run test:unit && npm run build && (npm run preview &) && until node -e \"fetch('http://127.0.0.1:4173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"; do sleep 1; done && npx playwright test --reporter=list"]

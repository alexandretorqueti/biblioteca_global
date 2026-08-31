FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/schema-tools/package.json packages/schema-tools/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY projects/biblioteca-global/package.json projects/biblioteca-global/package.json
COPY projects/documentacao/package.json projects/documentacao/package.json
COPY projects/gerenteagentes/package.json projects/gerenteagentes/package.json
RUN npm ci --include=dev
COPY . .
RUN npm run build --workspace @biblioteca-global/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1/health || exit 1

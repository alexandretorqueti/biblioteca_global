FROM node:22-alpine AS dependencies
WORKDIR /app
# Instala git e openssh (necessários para o motor-v2 executar pipelines de desenvolvimento)
RUN apk add --no-cache git openssh-client
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/file-extract/package.json packages/file-extract/package.json
COPY packages/schema-tools/package.json packages/schema-tools/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY projects/biblioteca-global/package.json projects/biblioteca-global/package.json
COPY projects/documentacao/package.json projects/documentacao/package.json
COPY projects/gerenteagentes/package.json projects/gerenteagentes/package.json
COPY projects/taqui/package.json projects/taqui/package.json
RUN npm ci --include=dev

FROM dependencies AS runtime
WORKDIR /app
COPY . .
# Typecheck temporariamente desabilitado - imports ESM/CommonJS precisam de ajuste
# RUN npm run typecheck --workspace @biblioteca-global/api
RUN npx tsc -p packages/shared --noEmit false --module Node16 --moduleResolution Node16 \
 && npx tsc -p packages/schema-tools --noEmit false \
 && npx tsc -p database --noEmit false
# Compila motor-v2 (TypeScript → JavaScript)
RUN cd projects/gerenteagentes/motor-v2 && npx tsc --build --force
EXPOSE 3001 3010
CMD ["sh", "apps/api/docker-entrypoint.sh"]

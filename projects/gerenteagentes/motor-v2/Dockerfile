# Motor-v2 — Dockerfile para uso via compose da biblioteca.
# Multi-stage: compila TypeScript dentro do Docker, não precisa de dist/ local.
# Contexto de build: raiz do repo (biblioteca-global).

# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /build

# Copia tsconfig base da raiz do repo (o extends do motor-v2 aponta pra ../../../tsconfig.base.json)
COPY tsconfig.base.json ./tsconfig.base.json

# Copia package.json e tsconfig do motor-v2
COPY projects/gerenteagentes/motor-v2/package.json ./
COPY projects/gerenteagentes/motor-v2/tsconfig.json ./tsconfig.json

# Ajusta o extends para apontar para o tsconfig.base.json local
RUN sed -i 's|"extends": "../../../tsconfig.base.json"|"extends": "./tsconfig.base.json"|' tsconfig.json

# Instala deps (incluindo typescript e devDeps)
RUN npm install --include=dev

# Copia fonte
COPY projects/gerenteagentes/motor-v2/src/ ./src/

# Compila
RUN npx tsc

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app

# Copia package.json e instala apenas deps de produção
COPY projects/gerenteagentes/motor-v2/package.json ./
RUN npm install --omit=dev

# Copia build do stage anterior
COPY --from=build /build/dist/ ./dist/

EXPOSE 3010

CMD ["node", "dist/start.js"]

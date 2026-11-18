# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copiar package.json do monorepo
COPY package*.json ./
COPY projects/chat-universal/package.json projects/chat-universal/
COPY packages/ui/package.json packages/ui/
COPY packages/api-client/package.json packages/api-client/
COPY packages/shared/package.json packages/shared/

# Instalar dependências
RUN npm install --include=dev

# Copiar código fonte
COPY projects/chat-universal projects/chat-universal
COPY packages packages
COPY tsconfig.base.json ./

# Build
RUN cd projects/chat-universal && npm run build

# Production stage
FROM nginx:1.27-alpine

# Copiar build para nginx
COPY --from=builder /app/projects/chat-universal/dist /usr/share/nginx/html

# Configuração do nginx
COPY projects/chat-universal/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

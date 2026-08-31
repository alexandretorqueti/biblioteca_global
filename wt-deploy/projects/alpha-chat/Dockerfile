# Build stage
FROM node:22-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY projects/alpha-chat/package.json ./projects/alpha-chat/
COPY packages/ui/package.json ./packages/ui/
COPY packages/api-client/package.json ./packages/api-client/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN npm install --include=dev

# Copy source code
COPY projects/alpha-chat ./projects/alpha-chat
COPY packages/ui ./packages/ui
COPY packages/api-client ./packages/api-client
COPY packages/shared ./packages/shared
COPY tsconfig.base.json ./

# Build
RUN cd projects/alpha-chat && npm run build

# Production stage
FROM nginx:1.27-alpine
COPY projects/alpha-chat/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/projects/alpha-chat/dist /usr/share/nginx/html
EXPOSE 80

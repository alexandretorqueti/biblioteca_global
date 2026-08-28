FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install mysql2

COPY dist/ ./dist/

EXPOSE 3010

CMD ["node", "dist/start.js"]

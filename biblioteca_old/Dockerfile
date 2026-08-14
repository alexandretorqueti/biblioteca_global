FROM node:22-alpine

WORKDIR /app

# Dev com bind mount: o node_modules do host é montado via compose (- .:/app),
# então não instalamos deps aqui (evita o conflito glibc/musl do rollup).
# Se precisar de deps na imagem, rode npm install explicitamente.

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

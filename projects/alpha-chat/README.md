# Isa Chat - Frontend Standalone

Componente React standalone do chat da Isa, usando `AgentChat` da biblioteca.

## Arquitetura

```
www.globaltecnologia.net (Cloudflare Pages)
├── Site HTML/CSS atual
└── React app (este projeto)
    └── Chama https://api.biblioteca.globaltecnologia.net/api/...
        └── Túnel Cloudflare → localhost:3003 (API da Biblioteca)
```

## Desenvolvimento

```bash
cd projects/gerenteagentes/isa-chat
npm install
npm run dev
```

Acesse `http://localhost:5175`

## Build para produção

```bash
npm run build
```

Gera `dist/` com HTML/JS/CSS estáticos.

## Deploy no Cloudflare Pages

1. Build local: `npm run build`
2. Upload do diretório `dist/` para o Cloudflare Pages
3. Ou configure deploy automático via Git

## Variáveis de ambiente

- `VITE_API_URL`: URL da API (padrão: `https://api.biblioteca.globaltecnologia.net`)

## Integração com site existente

Opção 1: Subdomínio dedicado
- Criar `isa.globaltecnologia.net` apontando para este app no Cloudflare Pages

Opção 2: Subdiretório
- Deploy em `www.globaltecnologia.net/chat/`
- Ajustar `base` no `vite.config.ts`

Opção 3: iframe
- Embed como iframe no site atual (substitui o legado)

## Componentes reutilizados

- `AgentChat` de `@biblioteca-global/ui`
- `createAgentChatClient` de `@biblioteca-global/api-client`
- Estilos da sidebar em `IsaChat.css`

## Dependências

Este projeto usa aliases do Vite para importar diretamente do source dos pacotes:
- `@biblioteca-global/ui` → `packages/ui/src`
- `@biblioteca-global/api-client` → `packages/api-client/src`
- `@biblioteca-global/shared` → `packages/shared/src`

Isso evita precisar buildar os pacotes separadamente.

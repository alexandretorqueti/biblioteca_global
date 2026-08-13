# Biblioteca Global 📚

Sistema de **biblioteca** da Global Tecnologia, organizado como monorepo de componentes/UI + apps.

## Tecnologia
- **Monorepo:** npm workspaces (`packages/*`, `apps/*`)
- **UI:** `@alexandretorqueti/biblioteca-global-ui` (publicado, v0.1.19)
- **Documentação app:** `@global/documentacao`
- **Runtime:** `node:22-alpine`
- **Build:** Rollup (atenção ao glibc/musl do `@rollup/rollup-linux-x64-gnu`)

## Repositório
- **Remoto:** _sem remote_ (a configurar na org `globaltecnologia`)
- **Publicação:** workflow `.github/workflows/publish-ui.yml` (pack do pacote UI)

## Portas
| Serviço | Container | Host |
|---------|-----------|------|
| biblioteca-gera (doc UI) | 5173 | 5174 |
| backend-exemplo | 3001 | 3003 |

## Ambientes
- **Desenvolvimento:** `docker compose up` — 2 serviços:
  - `biblioteca-gera` (Vite hot-reload, `CHOKIDAR_USEPOLLING=true` para bind mount)
  - `backend-exemplo` (API exemplo na porta 3001 interna; persistência em volume `backend_data`)

## Tokens e Chaves
- npm token para publish do pacote (`.github/workflows/publish-ui.yml`) — verificar secret `NPM_TOKEN`
- Repo de segredos: `/data/workspace/projects/agentes/devops/secrets/`

## Estrutura
```
biblioteca-global/
├── packages/          # Bibliotecas compartilhadas
├── apps/
│   ├── backend-exemplo/  # API exemplo (Dockerfile próprio)
│   └── documentacao/     # App de documentação da UI
├── compose.yaml
├── Dockerfile
└── .github/workflows/publish-ui.yml
```

## Subir
```bash
docker compose up -d
```
- Documentação/UI: http://localhost:5174
- Backend exemplo: http://localhost:3003

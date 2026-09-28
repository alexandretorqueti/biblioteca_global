# Projeto GerenteAgentes

Projeto piloto para gerenciamento de agentes de IA da Global Tecnologia.

## Estrutura

- `motor-v2` — motor de execução de tarefas (TypeScript)
- `motor-v3` — motor v3 integrado ao Banco de Dados (NestJS)
- `src` — código compartilhado entre os motores
- `migrations` — arquivos SQL gerados automaticamente a partir do schema TypeScript

## Configuração

### Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste as variáveis em `projects/gerenteagentes/.env.example`.

### Database

Este projeto usa Drizzle ORM com MySQL. O schema está em `schema.ts` e as migrations em `migrations/`.

## Comandos

### Geração de migrations

A cada alteração em `schema.ts`, as migrations devem ser geradas automaticamente pelo hook de pre-commit (Husky). O hook:

1. Verifica se houve alterações em `schema.ts`
2. Se sim, gera as migrations SQL com `drizzle-kit generate`
3. Adiciona o diretório `migrations/` ao commit

#### Bypass excepcional

Se necessário, execute `git commit --no-verify` para pular o hook (use com cuidado).

#### Verificação manual

```bash
# Gerar migrations manualmente
npm run db:generate:gerenteagentes

# Aplicar migrations ao banco
npm run db:migrate:gerenteagentes
```

### CI / CD

No workflow de CI, há uma verificação automática:

- Roda `db:generate:gerenteagentes`
- Verifica se há diferenças em `migrations/`
- Se houver, o commit falha com mensagem: "Migrations desatualizadas. Rode `npm run db:generate:gerenteagentes` e commit as mudanças."

### Solução de problemas

**Erro: "Migrations desatualizadas" no CI**

1. Rodar localmente:
   ```bash
   npm run db:generate:gerenteagentes
   git add projects/gerenteagentes/migrations/
   git commit -m "chore(migrations): atualizar após schema change"
   git push
   ```

2. Verificar se o hook de pre-commit está funcionando:
   ```bash
   # Verificar se o arquivo existe e é executável
   ls -la .husky/pre-commit
   
   # Testar manualmente
   .husky/pre-commit
   ```

## Schema

O schema TypeScript está em `projects/gerenteagentes/schema.ts`. Ele define:

- Tabelas para captação (Isa): contatos, projetos_captados, definicoes, chats, chat_mensagens
- Tabelas para execução (motor): tarefas, subtarefas, tarefa_chats, projeto_chats, geracoes_projeto, bloqueios
- Tabelas para agentes: agentes, prompts_agentes

Cada alteração no schema gera automaticamente um arquivo SQL em `migrations/` com o padrão `00XX_*.sql` e atualiza o `migrations/meta/_journal.json`.

## Deploy

O deploy usa o `ApplyProjectMigrationsCli` que lê o `migrations/meta/_journal.json` e aplica as migrations na ordem correta.

## License

MIT

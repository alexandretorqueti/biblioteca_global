# Memória do projeto

## 2026-10-05 — task-p1-815, subtarefa 1026 (validação integrada — motor-v3-work)

- **Decisão:** Implementação incompleta nesta branch. A validação estática passou (1471 testes, lint, build, git diff --check), mas a implementação do tratamento de erro global está parcial:
  - O filtro registra TODOS os erros (sem política `erroReportavel` — 404/401/etc. viram tarefa)
  - Sem `montarEndpointCanonico` (IDs não normalizados → deduplicação incompleta)
  - Sem módulo `POST /api/erros` (front não tem canal dedicado)
  - Sem `resolverProjetoCaptado` (projetoId da plataforma vai direto na FK)
  - Título usa "Erro de API:" (fix `90ef575c` em base-desenvolvimento não merged)
- **Branch com implementação completa:** `motor-v2/task-p1-815/integracao` — 47 testes específicos, todos os critérios de aceite atendidos.
- **Typecheck:** falha em `apps/api` e `projects/gerenteagentes` por erros preexistentes não relacionados (motor-v2 dist e isa-chat `origem`).
- **Bloqueio ambiental:** Docker indisponível.
- **Lição:** Antes de validar uma subtarefa, confirmar que a branch de integração contém toda a implementação (contratos, módulos, política). Branches diferentes podem ter escopos diferentes da mesma tarefa.

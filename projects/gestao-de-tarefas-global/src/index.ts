/**
 * Ponto de entrada do workspace do projeto `gestao-de-tarefas-global`.
 *
 * A fonte de verdade dos dados é o `schema.ts` na raiz do projeto —
 * carregado automaticamente pelo DynamicSchemaRegistry no boot da API
 * (whitelist de resources = nomes de tabela via coletarTabelas).
 * Contratos de domínio (máquinas de estado, recorrência, lembrete) entram
 * aqui nas subtarefas específicas do plano macro.
 */
export {}

# ADR: ConfigLintPolicy — Lint de config.ts e Validação de Completude no Gate VERIFY

> **Status:** Implementado (2026-09-03)
> **Contexto:** Lições do caso TaQui — subtarefa #3 do escopo de controles de fluxo para projeto novo.

## Decisão

Implementar o `ConfigLintPolicy` como política do motor-v2 que valida o `config.ts` do projeto novo na fase VERIFY do gate. O controle é aplicado em **código** (não apenas em prompt), garantindo que:

1. **FK number sem multipleChoice reprova** — campos com nome que sugere FK (terminam em `Id` ou `_id`) declarados como `type: "number"` sem `multipleChoice` são reprovados com diagnóstico claro.
2. **Tela custom sem implementação reprova** — telas com `kind: "custom"` e `componentId` que não têm arquivo correspondente em `projects/<slug>/screens/` são reprovadas.
3. **Actions sem handler reprovam** — `rowActions` e `actions` com endpoints declarados no config que não têm implementação correspondente no código são reprovadas.

## Motivação

### Problemas detectados no TaQui

1. **Combos de FK exibiam ID em vez de nome:** O config.ts do TaQui tinha campos como `condominioId` com `type: "number"` — a combo exibia o ID numérico em vez do nome do condomínio. A correção é usar `type: "multipleChoice"` com `multipleChoice: { resource: "condominios", idField: "id", displayField: "nome" }`.

2. **Telas custom declaradas mas não implementadas:** O config.ts declarava 4 telas custom (`taqui-registro-encomenda`, `taqui-painel-portaria`, `taqui-notificacoes-morador`, `taqui-confirmacao-recebimento`) mas nenhuma tinha implementação no diretório `screens/`. A tarefa fechou como concluída mesmo assim.

3. **Actions sem handler:** `rowActions` com endpoints declarados no config não tinham handlers correspondentes no backend.

### Princípio diretivo

> **Sempre que houver decisão ou proibição, ela deve ser CONTROLADA PELO MOTOR (código/gate), não apenas escrita no prompt do agente.** Prompt orienta; código obriga. — Alexandre, 2026-09-03

## Implementação

### Arquivo

`projects/gerenteagentes/motor-v2/src/policies/ConfigLintPolicy.ts`

### Funções principais

| Função | Descrição |
|--------|-----------|
| `lintFkNumberWithoutMultipleChoice(config)` | Detecta campos FK com `type: "number"` sem `multipleChoice` |
| `extractCustomScreenComponentIds(config)` | Extrai todos os `componentId` de telas custom |
| `extractActions(config)` | Extrai todos os `rowActions` e `actions` com endpoints |
| `hasCustomScreenImplementation(projectPath, slug, componentId)` | Verifica se existe arquivo de implementação da tela custom |
| `hasActionImplementation(projectPath, actionPath)` | Verifica se existe handler para o endpoint da action |
| `lintConfig(config)` | Aplica todas as regras de lint |
| `validateCompleteness(projectPath, slug, config)` | Valida completude das declarações |
| `validateProjectConfig(projectPath, slug)` | Validação completa (lint + completude) |
| `formatConfigValidationReport(result)` | Formata relatório legível para o gate |

### Regras de lint

#### FK number sem multipleChoice

- **Padrão detectado:** campo com `name` terminando em `Id` ou `_id` E `type: "number"` E sem `multipleChoice` no bloco.
- **Diagnóstico:** `Campo FK "condominioId" declarado como type: "number" sem multipleChoice. A combo exibirá ID em vez de nome.`
- **Sugestão:** `Alterar para: { name: "condominioId", type: "multipleChoice", multipleChoice: { resource: "<resource>", idField: "id", displayField: "nome" } }`

#### ComponentId fora do padrão

- **Padrão detectado:** `componentId` que não segue kebab-case (`/^[a-z][a-z0-9-]*$/`).
- **Severidade:** warning (não bloqueia, mas orienta).

### Validação de completude

#### Telas custom

- **Verificação:** para cada `kind: "custom"` com `componentId`, busca arquivo correspondente em `projects/<slug>/screens/`.
- **Busca:** correspondência exata (case-insensitive) ou parcial (contains).
- **Falha:** `Tela custom "taqui-painel" declarada no config.ts mas sem implementação em projects/taqui/screens/.`

#### Actions/rowActions

- **Verificação:** para cada action com `path` (que não seja URL externa), busca implementação no código.
- **Busca heurística:** procura o path ou último segmento em arquivos `.ts`/`.tsx` de `apps/api/src` e `projects/`.
- **Falha:** `Action "confirmar" com endpoint "/api/taqui/:id/confirmar" declarada no config.ts mas sem implementação encontrada.`

### Integração com o gate

O `ConfigLintPolicy` é chamado pela fase VERIFY do `TaskWorker` quando a tarefa é de setup de projeto novo (detectado por `isSetupTask()`). O relatório formatado é incluído na mensagem de erro do gate quando a validação falha.

## Testes

34 testes no `ConfigLintPolicy.test.ts` cobrindo:

- Detecção de FK number sem multipleChoice (7 testes)
- Extração de componentIds de telas custom (4 testes)
- Extração de actions/rowActions (3 testes)
- Verificação de implementação de telas custom (4 testes)
- Verificação de implementação de actions (2 testes)
- Lint completo (3 testes)
- Validação de completude (4 testes)
- Validação completa do projeto (2 testes)
- Formatação de relatório (3 testes)
- Leitura de config (2 testes)

## Consequências

### Positivas

- **Controle em código:** o gate reprova automaticamente config.ts com problemas, independente do agente seguir ou não as orientações do prompt.
- **Diagnóstico claro:** cada erro inclui mensagem explicativa e sugestão de correção.
- **Detecção precoce:** problemas são identificados na fase VERIFY, antes de a tarefa ser marcada como concluída.

### Negativas

- **Busca heurística de actions:** a verificação de implementação de actions é baseada em busca de texto, que pode ter falsos positivos/negativos. Aceitável como primeira implementação; pode ser refinada no futuro.
- **Parsing por regex:** o config.ts é parseado como texto (regex), não como AST. Funciona para os padrões atuais mas pode falhar em configs muito complexas. Se necessário, migrar para parser TypeScript no futuro.

## Referências

- [CONTROLES_FLUXO_PROJETO_NOVO.md](../../docs/CONTROLES_FLUXO_PROJETO_NOVO.md) — documento principal de controles
- [ADR-SMOKE-TEST-SETUP.md](./ADR-SMOKE-TEST-SETUP.md) — smoke test funcional (controle relacionado)
- Subtarefa #3 do escopo: Gate VERIFY: lint de config.ts e validação de completude

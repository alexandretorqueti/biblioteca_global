# Análise de utilização: `project_model_selection`

## Conclusão

`project_model_selection` **é utilizada atualmente** e possui consumidores
ativos no Gerente de Agentes. A tabela não deve ser removida nem considerada
legado sem substituição.

## Finalidade

A tabela mantém, por projeto (`project_slug`) e tipo de agente (`DEV`,
`ANALYST` ou `MONITOR`), a cadeia ordenada de modelos (`ordem`, `provider`,
`model`) e o indicador de habilitação (`enabled`). O motor consulta essa
cadeia para selecionar o modelo a ser usado em cada fase da execução.

## Pontos de uso encontrados

| Camada | Evidência | Uso |
| --- | --- | --- |
| Motor — execução | `motor-v2/src/coordinator/TaskCoordinator.ts:1464-1474` | Faz `SELECT provider, model, ordem ... WHERE project_slug = ? AND tipo = ? AND enabled = 1 ORDER BY ordem ASC` para montar a cadeia de modelos. |
| Motor — API | `motor-v2/src/api/MotorAPI.ts:207-212` | Lê as entradas para o endpoint `GET /api/model-selection/:projectKey/:tipo`. |
| Motor — API | `motor-v2/src/api/MotorAPI.ts:267-278` | Remove e insere as entradas no endpoint `PUT /api/model-selection/:projectKey/:tipo`. |
| API do projeto | `api/gerenteagentes.service.ts:901-955` e `api/gerenteagentes.controller.ts:209-217` | Expõe os endpoints da Biblioteca como proxy para o motor e valida o contrato de seleção. |
| Interface | `screens/ModelSelectionScreen.tsx:2-16, 105-219` | Carrega e salva a seleção por projeto/tipo, permitindo editar ordem, provider, modelo e habilitação. |
| Testes | `api/__tests__/gerenteagentes.service.model-selection.spec.ts:97-149` e `screens/__tests__/ModelSelectionScreen.test.tsx:114-402` | Cobrem o proxy e o fluxo de leitura, edição e gravação da seleção. |

## Impacto operacional

- Sem uma seleção habilitada para o projeto e a fase, `getProjectModelChain`
  lança erro de configuração ausente (`TaskCoordinator.ts:1476-1478`),
  impedindo o consumo do modelo nessa fase.
- Alterações na tabela têm efeito direto na escolha e na ordem de fallback
  dos modelos usados pelo motor.
- A interface grava a configuração substituindo todas as entradas do par
  `project_slug`/`tipo`; a operação deve ser tratada como configuração
  operacional, não como dado descartável.

## Inventário de definição e configuração global

As tabelas são declaradas em `schema.ts` e provisionadas pelas migrations
`0036_global_model_selection.sql` e `0037_inherit_global_model_selection.sql`:

- `global_model_selection` guarda uma fila por `DEV`, `ANALYST` e `MONITOR`;
- `project_model_selection` guarda a cópia materializada por projeto e tipo;
- o trigger da migration `0037` copia as três filas ao inserir um projeto,
  somente se ainda não houver seleção para aquele slug.

A configuração global não é um fallback de leitura. Ela é persistida e depois
materializada nos projetos existentes pela operação de propagação; portanto,
uma edição individual posterior continua sendo a fonte daquele projeto. A
aplicação global não é atômica entre projetos: cada projeto é transacionado
separadamente.

## Recomendação

**Manter as tabelas.** Há consumidores de leitura, escrita e interface ativos;
removê-las quebraria a configuração de modelos e pode bloquear execuções.
Qualquer alteração deve preservar a separação entre a configuração global e a
cópia individual, além de validar a migration e a propagação parcial.

Limites conhecidos de `project_model_selection`: a tabela não registra se uma
linha foi herdada ou editada; não há vínculo de versão entre global e projeto;
uma nova propagação substitui as três filas dos projetos que forem aplicados;
e falhas em um projeto não desfazem projetos anteriores. O slug precisa ser
estável e único no cadastro de projetos.

Notas operacionais da migration `0037`: o `CREATE TRIGGER` exige privilégio
`SUPER` (ou `log_bin_trust_function_creators=1`) quando o binlog está habilitado;
e a comparação `project_model_selection.project_slug = projetos_captados.slug`
usa `COLLATE` explícito porque as collations das duas colunas podem divergir.

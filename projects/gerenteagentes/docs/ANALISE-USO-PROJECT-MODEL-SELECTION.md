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

## Inventário de definição

Não foi encontrada declaração de `project_model_selection` em `schema.ts` nem
em `migrations/*.sql` deste projeto. Isso não caracteriza ausência de uso:
o motor acessa a tabela diretamente via SQL e a tabela pode ser provisionada
fora das migrations locais. Recomenda-se confirmar e registrar no inventário
de banco onde a tabela é criada e como ela é migrada antes de qualquer
alteração estrutural.

## Recomendação

**Manter a tabela.** Há consumidores de leitura, escrita e interface ativos;
removê-la quebraria a configuração de modelos e pode bloquear execuções.
Qualquer substituição deve primeiro migrar o `TaskCoordinator`, a API, a
tela e os testes, com validação de dados e plano de rollback. Como ação de
manutenção, documentar a origem/provisionamento da tabela e avaliar a
inclusão de uma migration ou mecanismo formal de schema compatível com o
banco do motor.

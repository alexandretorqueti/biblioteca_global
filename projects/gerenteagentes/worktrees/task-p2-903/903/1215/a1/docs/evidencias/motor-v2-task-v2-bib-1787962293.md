# Evidências — Teste Motor-v2 Biblioteca

**Tarefa:** `task-v2-bib-1787962293`  
**Projeto:** `biblioteca-global` (`projetos_captados.id = 1`)  
**Coleta:** 2026-08-29 (UTC)  
**Branch observada:** `base-desenvolvimento`

## Resultado observado

O repositório contém o artefato gerado pelo ciclo anterior:

- `ciclo-test.txt`: `Motor v2 ciclo completo OK.`
- commit do artefato: `808a4cd` (`motor-v2: arquivos criados pelo motor (ciclo completo OK)`)

O banco `projeto_640` confirma a configuração do alvo:

| Item | Valor observado |
| --- | --- |
| `projetos_captados.slug` | `biblioteca-global` |
| `projetos_captados.repo_path` | `/run/media/alexandre/12T/codigofonte/biblioteca-global` |
| `projetos_captados.branch_trabalho` | `base-desenvolvimento` |
| `projetos_captados.build_command` | `npm run build` |
| `projetos_captados.unit_test_command` | `npm run test` |
| tarefa `status` | `ready` |
| subtarefa 1 | `verified` |
| subtarefa 2 | `running` |
| subtarefa 3 | `pending` |

Enquanto a subtarefa 2 estava em execução, o lock observado foi
`project:biblioteca-global:execution`, com `execution_id`
`exec-execute-649-1787965440586`. Isso demonstra que o fluxo mantém o
isolamento por projeto durante a execução. Nenhum estado foi alterado durante
esta validação.

## Verificações executadas

Executadas em `projects/gerenteagentes/motor-v2`:

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | PASSOU |
| `npm run build` | PASSOU |
| `npm run lint` | PASSOU |
| `npm test` | PASSOU — 3 arquivos, 19 testes |
| `git diff --check` | PASSOU |

Também foi executado o teste amplo selecionando `projects/gerenteagentes`:
62 testes passaram em 9 arquivos, mas `TaskCoordinator.test.ts` falhou ao ser
carregado pelo harness raiz com `Error: No such built-in module: node:`. O
erro ocorre na configuração de execução do Vitest raiz, pois a suíte isolada
do pacote Motor-v2 passa integralmente; fica registrado como divergência de
ambiente a corrigir antes de usar esse comando amplo como gate.

## Tentativa de execução — 2026-08-29 (UTC)

O Motor-v2 foi iniciado sem erro de configuração e selecionou a subtarefa #2
automaticamente. O log confirmou, nesta ordem, PREPARE → EXECUTE → envio ao
programador, com `runId` válido. Porém, a sessão do Console permaneceu
`running` por mais de 13 minutos sem resposta final; o lease expirou e o
reconciliador registrou repetidamente `Lease não encontrado ou fencing token
inválido`. Durante a tentativa, `projeto_640.tarefas` e
`projeto_640.subtarefas` passaram a ter zero registros, impossibilitando a
persistência de `verified`/`completed`.

Estado final observado: worker ainda ativo, sessão ainda `running`, tarefa não
concluída. Portanto, os critérios de aceite de sucesso não foram atingidos.

## Conclusão e pendências

Os artefatos e os testes específicos do Motor-v2 são consistentes com o
comportamento esperado e permitem rastrear o ciclo por commit, estado da
tarefa, subtarefas e lock. A execução ponta a ponta atualmente não deve ser
declarada encerrada nesta evidência: a subtarefa 2 ainda está `running` e a
subtarefa 3 permanece `pending` no banco. O próximo registro deve atualizar
este documento com os estados finais, logs do worker e resultado da validação
do fluxo completo.

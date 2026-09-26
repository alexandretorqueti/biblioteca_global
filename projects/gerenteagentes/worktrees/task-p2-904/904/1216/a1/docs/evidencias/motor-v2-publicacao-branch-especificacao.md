# Especificação do teste de publicação de branch — Motor-v2

**Tarefa pai:** Validar publicação de branch pelo Motor-v2
**Subtarefa:** Levantar conteúdo definido para o teste de publicação
**Data da consolidação:** 2026-08-29 (UTC)
**Status:** especificação consolidada; execução ponta a ponta é posterior

## 1. Identificação do alvo

| Item | Valor definido |
| --- | --- |
| Projeto captado | `biblioteca-global` |
| Database e registro | `projeto_640.projetos_captados`, ID `1` |
| Tarefa | `task-v2-bib-1787962293` |
| Agente | `biblioteca-global` |
| Branch base | `base-desenvolvimento` |
| Motor | `MOTOR_VERSION=v2` |
| API do motor | porta `3010` |
| Caminho do repositório no host | `/run/media/alexandre/12T/codigofonte/biblioteca-global` |
| Montagem | `REPO_PATH` deve montar diretamente o diretório do repositório no container da API |
| Build | `npm run build` |
| Testes | `npm run test` |

O caminho do host acima e o caminho de execução do processo precisam ser o mesmo
alvo montado no container. A configuração não deve apontar apenas para o diretório
pai. `MYSQL_*`, `OPENCLAW_CONSOLE_URL` e `OPENCLAW_CONSOLE_TOKEN` são somente
variáveis locais; nenhum segredo deve aparecer no documento, no commit ou no
payload da tarefa.

Resolução de contexto: a anotação histórica de `MEMORY.md:17`, que recomendava
armazenar no banco um caminho interno diferente (`/data/workspace/...`), refere-se
ao arranjo anterior. Para este teste, vale a configuração de 2026-08-29
(`MEMORY.md:5`) e o bind direto documentado no README: o caminho configurado é
`/run/media/alexandre/12T/codigofonte/biblioteca-global` e esse mesmo caminho deve
existir no container.

## 2. Objetivo do teste

Comprovar que o Motor-v2 executa uma subtarefa no workspace Git isolado derivado
de `base-desenvolvimento`, cria o artefato de validação, passa pelos gates de
build e testes, cria o commit técnico aprovado e publica esse commit na branch
remota de trabalho.

O teste valida publicação de branch, não merge na branch base, deploy ou
publicação de pacote. A branch base deve permanecer sem checkout, merge ou escrita
causada pelo worker.

## 3. Conteúdo exato do artefato de validação

O ciclo deve produzir, na raiz do workspace de trabalho, o arquivo:

```text
ciclo-test.txt
```

O conteúdo esperado é exatamente uma linha, sem texto adicional:

```text
Motor v2 ciclo completo OK.
```

O arquivo deve fazer parte do commit técnico criado após o gate VERIFY. A
especificação não exige a publicação de `hello-motor.txt` ou `motor-test.txt`;
esses arquivos são artefatos de ciclos anteriores e não substituem
`ciclo-test.txt`.

## 4. Pré-condições

Antes de iniciar o motor, confirmar todos os itens abaixo:

- o checkout principal está limpo (`git status --porcelain` sem saída);
- a branch `base-desenvolvimento` existe localmente e resolve para um commit;
- o remote `origin` está configurado e é o remoto autorizado para o teste;
- `REPO_PATH` aponta para o diretório do repositório montado no container;
- o compose está com `MOTOR_VERSION=v2` e publica a porta `3010`;
- o endpoint `GET /api/motor/health` responde com sucesso;
- o banco contém o projeto captado ID `1` e a tarefa identificada acima;
- a tarefa está elegível (`ready`/`planned`, conforme a transição efetiva do
  coordenador) e possui a subtarefa a executar;
- `branch_trabalho`, `repo_path`, `build_command` e `unit_test_command` estão
  preenchidos para a configuração operacional;
- as credenciais do MySQL e do Console estão disponíveis apenas no ambiente
  local;
- a execução será feita com um único lock de projeto, sem outra execução
  concorrente de `biblioteca-global`.

## 5. Passos de execução

1. Subir/iniciar a API com o Motor-v2 habilitado e confirmar o health check em
   `http://localhost:3010/api/motor/health`.
2. Acionar o ciclo pelo pump do motor ou aguardar o ciclo periódico:
   `POST http://localhost:3010/api/motor/pump`.
3. Confirmar no log e no banco a aquisição do recurso
   `project:biblioteca-global:execution`.
4. Confirmar a fase PREPARE: o motor resolve o commit de
   `base-desenvolvimento`, cria um worktree isolado e trabalha em uma branch
   exclusiva. Para a primeira tentativa da subtarefa 1, o nome esperado é
   `motor-v2/task-v2-bib-1787962293/1/a1`.
5. Confirmar a fase EXECUTE e a criação do `ciclo-test.txt` com o conteúdo exato
   da seção 3.
6. Confirmar a fase VERIFY com sucesso em `npm run build` e `npm run test` no
   workspace isolado.
7. Confirmar a fase COMMIT: o motor executa `git add -A`, cria o commit técnico
   somente no worktree e captura o SHA completo.
8. Confirmar a fase PUBLISH: o motor publica somente o commit aprovado usando
   `git push --set-upstream origin <commit>:refs/heads/<branch-de-trabalho>`.
9. Conferir no remote a existência da branch de trabalho e verificar que o SHA
   remoto é o mesmo SHA produzido na fase COMMIT.
10. Conferir que `ciclo-test.txt` existe na branch remota e tem o conteúdo exato;
    conferir também que `base-desenvolvimento` não recebeu merge nem alteração.
11. Registrar no documento de evidências o SHA, a branch remota, os estados da
    tarefa/subtarefa, os logs relevantes e os comandos de validação executados.

## 6. Resultados esperados

- o health check do Motor-v2 responde com sucesso na porta `3010`;
- PREPARE usa `base-desenvolvimento` como base e mantém o checkout principal
  intocado;
- o lock por projeto é adquirido e liberado sem conflito;
- o artefato `ciclo-test.txt` contém exatamente `Motor v2 ciclo completo OK.`;
- build e testes passam no workspace isolado;
- existe um commit técnico no worktree, criado depois do VERIFY;
- a branch de trabalho gerada existe no `origin` e aponta para esse commit;
- a publicação não executa merge, deploy, limpeza destrutiva ou publicação de
  pacote;
- a tarefa/subtarefa alcança os estados finais de sucesso definidos pelo fluxo
  (`verified` e tarefa concluída, quando aplicável ao ciclo completo);
- o lock é liberado e não fica execução órfã;
- a evidência contém dados suficientes para reproduzir e auditar o ciclo sem
  expor credenciais.

## 7. Critérios de aceite

O teste só é aceito quando todos os critérios forem verdadeiros:

- [ ] alvo, tarefa, branch base, versão do motor, porta e `REPO_PATH` conferem
      com a seção 1;
- [ ] pré-condições da seção 4 foram verificadas e registradas;
- [ ] PREPARE criou o worktree/branch exclusiva a partir de
      `base-desenvolvimento`;
- [ ] `ciclo-test.txt` foi criado na raiz do workspace e seu conteúdo é
      exatamente o especificado;
- [ ] `npm run build` e `npm run test` passaram no workspace isolado;
- [ ] o commit técnico foi criado depois do gate VERIFY e seu SHA foi
      registrado;
- [ ] a branch remota de trabalho foi publicada apontando para o mesmo SHA;
- [ ] o arquivo e seu conteúdo foram verificados na branch remota;
- [ ] `base-desenvolvimento` não foi alterada por merge, checkout ou escrita do
      worker;
- [ ] o lock foi liberado e os estados finais da tarefa/subtarefa foram
      persistidos sem execução órfã;
- [ ] a evidência registra comandos, timestamps, branch, SHA e resultado, sem
      segredos;
- [ ] qualquer falha em um item deixa o teste como **não aceito**, mesmo que os
      testes unitários do Motor-v2 estejam verdes.

## 8. Rastreabilidade e resolução de ambiguidades

- Configuração do alvo e credenciais: `MEMORY.md:5`.
- Registro operacional, comandos de health/pump e regra de não versionar
  segredos: `projects/gerenteagentes/motor-v2/README.md:91-112`.
- Pipeline e ordem PREPARE → EXECUTE → VERIFY → COMMIT → PUBLISH:
  `projects/gerenteagentes/motor-v2/src/workers/TaskWorker.ts:1-10,279-374`.
- Fórmula da branch exclusiva e validação do checkout base:
  `projects/gerenteagentes/motor-v2/src/workspaces/GitWorkspaceManager.ts:68-86`.
- Requisito de checkout principal limpo e configuração operacional:
  `projects/gerenteagentes/motor-v2/src/workspaces/GitWorkspaceManager.ts:76-79`
  e `projects/gerenteagentes/motor-v2/src/coordinator/TaskCoordinator.ts:563-570`.
- Evidência anterior do ciclo e conteúdo de `ciclo-test.txt`:
  `docs/evidencias/motor-v2-task-v2-bib-1787962293.md:8-26`.
- Regras gerais de validação, segredos e protocolo do agente:
  `MANUAL_DESENVOLVIMENTO.md:96-123` e `POC_DEFINICOES.md:385-394`.

Não existe nota diária separada em `memory/2026-08-29.md` neste workspace; o
registro de 2026-08-29 usado para esta consolidação está em `MEMORY.md:5`. A
ausência da nota diária não deixa requisito operacional indefinido, porque os
valores do alvo estão confirmados também no README do Motor-v2 e na evidência
existente.

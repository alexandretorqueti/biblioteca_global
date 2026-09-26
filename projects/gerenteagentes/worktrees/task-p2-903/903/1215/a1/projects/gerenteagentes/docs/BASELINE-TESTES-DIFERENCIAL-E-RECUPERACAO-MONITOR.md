# Baseline de testes, validação diferencial e recuperação pelo Monitor

Data do alinhamento: 2026-09-21

## Problema observado

A tarefa 855 alterou somente a capitalização de um texto e produziu um diff válido, mas foi marcada como falha porque a suíte global já continha erros anteriores. O Motor v3 não executa um baseline antes de criar a worktree do DEV e, por isso, não distingue falha preexistente de regressão introduzida pela tarefa.

## Regra desejada

1. Antes de enviar uma subtarefa ao DEV, executar build e testes na branch de integração, no commit-base exato que originará a worktree.
2. Persistir a execução, inclusive quando passar, com horários, commit, branch, workspace, comandos, ambiente e artefatos.
3. Se o baseline falhar, registrar as falhas preexistentes e permitir que o desenvolvimento continue.
4. Após o DEV concluir, executar o mesmo gate no worktree e comparar o resultado com o baseline.
5. Somente falhas novas ou pioradas devem reprovar a alteração e gerar rework para o DEV.
6. Falhas resolvidas pela alteração devem ser registradas como melhoria; falhas preexistentes inalteradas não devem reprovar a tarefa.
7. A interface deve exibir o histórico das execuções e as falhas associadas a cada uma.
8. A tarefa funcional pode ser concluída quando não introduzir regressões, mas promoção/deploy permanece bloqueado enquanto o gate efetivo estiver vermelho.
9. Após a conclusão funcional, o Monitor deve abrir uma execução de recuperação para tentar corrigir as falhas preexistentes.
10. Se a recuperação falhar, o Monitor deve publicar no chat da tarefa um diagnóstico objetivo e colocar a pendência em `aguardando_retorno_usuario`.

## Refinamentos necessários

### Comparação por assinatura, não por texto bruto

Cada falha deve possuir uma assinatura normalizada e versionada, por exemplo:

`runner + suite + test_case + error_type + normalized_message + source_file + source_line_semantic`

Remover da assinatura dados voláteis como ANSI, duração, PID, caminho absoluto da worktree, timestamps, IDs e números de porta. O texto bruto permanece armazenado como evidência. A comparação deve classificar cada ocorrência como:

- `new`: não existia no baseline;
- `pre_existing`: mesma assinatura no baseline e no pós-DEV;
- `resolved`: existia no baseline e desapareceu;
- `worsened`: mesma falha, mas com aumento relevante de ocorrências ou severidade;
- `flaky_or_inconclusive`: resultado instável ou ambiente não comparável.

### Paridade de ambiente

Baseline e pós-DEV devem usar a mesma imagem/runtime, variáveis não secretas, versão do Node, lockfile, estratégia de instalação e comandos. Se isso não ocorrer, a comparação é inconclusiva e não pode culpar o DEV.

### Escopo da validação

Executar primeiro validação proporcional ao diff e depois o gate obrigatório do projeto. O baseline precisa cobrir exatamente o mesmo gate usado depois do DEV. Testes afetados podem dar retorno rápido, mas não substituem o gate obrigatório de promoção/deploy.

### Estados separados

Não usar um único status para representar entrega funcional e possibilidade de deploy. Manter dimensões independentes:

- `task_delivery_status`: execução funcional da tarefa;
- `verification_status`: regressões novas da tarefa;
- `project_test_health`: saúde atual do gate;
- `deployment_status`: elegibilidade de promoção/deploy;
- `recovery_status`: tentativa do Monitor sobre dívida preexistente.

Assim, uma tarefa pode estar `completed` e `verified_without_regression`, enquanto o projeto fica `tests_failing_pre_existing` e `deployment_blocked`.

### Recuperação pelo Monitor

A recuperação não deve alterar silenciosamente a tarefa já concluída. Deve criar uma execução/subtarefa corretiva vinculada às assinaturas preexistentes, em worktree própria, com limite de tentativas e auditoria. Se a correção passar, executar novamente o gate completo antes de liberar deploy. Se falhar, registrar diagnóstico e publicar a mensagem no chat da tarefa de origem.

## Persistência proposta

### `test_runs`

- id, project_id, task_id, subtask_id;
- phase (`baseline`, `post_dev`, `rework`, `monitor_recovery`, `pre_deploy`);
- commit_sha, base_commit_sha, branch, workspace_path;
- build_command, test_command, working_directory;
- runtime/image, node_version, lockfile_hash, environment_fingerprint;
- started_at, finished_at, exit_code, status;
- stdout/stderr ou referências para artefatos;
- baseline_run_id e comparison_status.

### `test_failures`

- id, test_run_id;
- fingerprint_version, fingerprint;
- suite, test_case, error_type, normalized_message;
- source_file, source_line;
- raw_excerpt, occurrence_count, severity;
- classification em relação ao baseline.

### `test_recovery_attempts`

- id, project_id, source_task_id, source_test_run_id;
- monitor_session_key, workspace_path, branch;
- status, attempt_count, started_at, finished_at;
- diagnosis, resolution, user_message_id.

## Política de decisão

- Baseline verde + pós-DEV verde: concluir e permitir promoção.
- Baseline verde + pós-DEV vermelho: regressão; devolver ao DEV com somente as falhas novas.
- Baseline vermelho + sem falhas novas: concluir funcionalmente, bloquear deploy e acionar recuperação do Monitor.
- Baseline vermelho + falhas novas: devolver ao DEV apenas as falhas novas; manter as preexistentes atribuídas ao Monitor.
- Baseline vermelho + falhas resolvidas e nenhuma nova: concluir, registrar melhoria; liberar deploy somente se o gate final ficar verde.
- Ambiente divergente/inconclusivo: não culpar DEV; bloquear promoção e abrir incidente operacional.

## Tela de histórico

Criar uma tela de saúde de testes por projeto e ligação na tarefa, contendo:

- linha do tempo dos runs;
- fase, commit, branch, duração, ambiente e comandos;
- totais de testes aprovados/falhos;
- grupos `novos`, `preexistentes`, `resolvidos`, `piorados` e `inconclusivos`;
- expansão do erro bruto e assinatura normalizada;
- vínculo com tarefa, subtarefa, sessão DEV e recuperação do Monitor;
- motivo do bloqueio de deploy e ação que pode desbloqueá-lo.

## Critério de deploy

Deploy nunca deve depender apenas do status `completed` da tarefa. Antes da promoção, deve existir um `pre_deploy` verde no commit exato a ser promovido. Qualquer falha, inclusive preexistente, mantém o deploy bloqueado até correção ou decisão humana explícita e auditada sobre uma política de exceção futura.

## Estado da implementação

Atualizado em 2026-09-21 após o endurecimento do fluxo.

### Pronto

- Baseline executado antes do DEV no commit-base da worktree.
- Comparação por fingerprint normalizado, sem caminhos voláteis de worktree, ANSI, duração, PID, porta ou IDs transitórios.
- Classificações `new`, `pre_existing`, `resolved`, `worsened` e `flaky_or_inconclusive` persistidas.
- Somente `new` e `worsened` são devolvidos ao DEV; o prompt declara explicitamente que falhas preexistentes estão fora do rework.
- Rework reaproveita a mesma sessão quando o mesmo modelo permanece disponível; troca de modelo abre sessão nova com contexto corretivo.
- Fingerprint ambiental inclui Node, plataforma, arquitetura, identidade do container, hash de `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`, comandos e variáveis não secretas permitidas (`CI`, `NODE_ENV`, `TZ`, `LANG`).
- Divergência ambiental produz comparação `inconclusive` e não atribui culpa ao DEV.
- Uma regressão nova é repetida uma vez, por padrão, antes da atribuição. Se desaparecer, é marcada `flaky_or_inconclusive` e bloqueia promoção sem reprovar o DEV. `MOTOR_TEST_FLAKY_RETRIES=0` desativa a confirmação.
- Baseline é reutilizado por projeto + commit + fingerprint ambiental + comandos; cada uso ganha um novo `test_run` com `reused_from_run_id`, preservando auditoria por tarefa/subtarefa.
- Logs integrais são gravados como artefatos gzip; o banco mantém somente os 20 kB finais para consulta rápida e os caminhos dos artefatos.
- Recuperação do Monitor usa worktree independente, registro próprio e limite operacional; falha publica diagnóstico no chat e deixa `test_recovery_attempts.status=awaiting_user` sem reabrir a entrega funcional.
- O detalhe da tarefa mostra separadamente entrega, verificação, saúde do projeto, deploy e recuperação.
- A tela de saúde mostra linha do tempo, classificações, evidências e resumo de projetos verdes, bloqueados e inconclusivos.
- O pedido de deploy executa um gate `pre_deploy` novo no checkout de integração, verifica que o `HEAD` continua no commit esperado e só enfileira o deploy quando esse run estiver verde e sem falhas.
- O SHA aprovado no `pre_deploy` acompanha o lote até `deploy-blue-green.sh`; o script compara `git rev-parse HEAD` antes de construir imagens e aborta se houver qualquer divergência.
- Subtarefa definitivamente `failed` deriva a tarefa para `failed`, levando-a à estação **Atenção**. Isso corrige o defeito observado na tarefa 855.
- Baseline, pós-DEV, rework, recuperação e pré-deploy são solicitados por `TEST_RUN_REQUESTED` em fila RabbitMQ dedicada (`motor.test-gates`). O pedido e o job são gravados atomicamente em `motor_outbox` e `test_gate_jobs`.
- Cada gate produz `TEST_RUN_COMPLETED`, mantém `correlationId`/`causationId` e registra recebimento/resultado em `motor_operation_log`. Reentrega é idempotente pelo `request_message_id` único e pelo claim `pending → processing`.
- A fila de gates possui consumidor, retry e DLQ próprios, evitando deadlock com o consumidor principal de tarefas que aguarda o resultado persistido.
- O outbox suporta roteamento por `destination_queue`; mensagens de tarefa e de teste continuam usando a mesma garantia transacional, mas filas independentes.
- Tarefas `verificacao` e subtarefas declaradas com `completion_kind=analysis|no_code_change|external_operation` podem terminar sem alteração Git. A conclusão emite `SUBTASK_NO_CODE_COMPLETED` e `TASK_EXECUTION_COMPLETED` pelo outbox.

### Operação necessária antes de publicar esta revisão

- Aplicar `migrations/0058_test_gate_hardening.sql`.
- Aplicar `migrations/0059_message_driven_test_gates.sql`.
- Compilar Motor v2, Motor v3 e aplicação antes do deploy.
- O diretório padrão de artefatos é o volume persistente do workspace em `/data/workspace/projects/agentes/gerenteagentes/artifacts/test-runs`; `MOTOR_TEST_ARTIFACTS_DIR` permite substituí-lo sem alterar código.
- Executar uma tarefa nova de ponta a ponta; a tarefa 855 não possui baseline retroativo porque falhou antes da implantação do mecanismo.

### Ainda não implementado

- Armazenamento remoto de artefatos (S3/MinIO ou equivalente), retenção e limpeza automática. O contrato atual usa filesystem.
- Política de exceção manual ao bloqueio de deploy. Deliberadamente não existe bypass: qualquer gate vermelho, ausente ou inconclusivo bloqueia.

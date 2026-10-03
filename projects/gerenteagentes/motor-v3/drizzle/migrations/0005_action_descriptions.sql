-- Adiciona descrições resumidas para as ações canônicas do catálogo.
ALTER TABLE `motor_actions`
  ADD COLUMN `description` text NULL AFTER `name`;

UPDATE motor_actions SET description='Arquivar sessão ativa e iniciar nova geração para recuperar contexto limpo' WHERE code='A01_SANITIZE';
UPDATE motor_actions SET description='Colocar o modelo atual em cooldown e escalar para o próximo modelo disponível' WHERE code='A02_ESCALATE';
UPDATE motor_actions SET description='Bloquear a tarefa, persistir o motivo e registrar a falha terminal' WHERE code='A03_BLOCK';
UPDATE motor_actions SET description='Verificar o estado do repositório e executar build e testes' WHERE code='A04_VERIFY_BUILD';
UPDATE motor_actions SET description='Enviar feedback corretivo, marcar retry e registrar a tentativa' WHERE code='A05_FEEDBACK';
UPDATE motor_actions SET description='Marcar a execução para nova tentativa e registrar o retry transitório' WHERE code='A06_RETRY';
UPDATE motor_actions SET description='Pausar a fila de agentes e registrar a necessidade de aguardar' WHERE code='A07_PAUSE';
UPDATE motor_actions SET description='Retomar o processamento da fila de agentes pausada' WHERE code='A08_RESUME';
UPDATE motor_actions SET description='Criar o worktree isolado e instalar as dependências do projeto' WHERE code='A09_PREPARE';
UPDATE motor_actions SET description='Criar o commit da subtarefa e mesclar sua branch na branch da tarefa' WHERE code='A10_COMMIT_MERGE';
UPDATE motor_actions SET description='Reverter o merge, marcar o retorno e registrar a recuperação' WHERE code='A11_REVERT';
UPDATE motor_actions SET description='Publicar a branch, marcar a integração e registrar o resultado' WHERE code='A12_PUBLISH';
UPDATE motor_actions SET description='Persistir o plano de análise e criar as subtarefas aprovadas' WHERE code='A13_FINALIZE';
UPDATE motor_actions SET description='Promover as alterações para a base e enfileirar o deploy' WHERE code='A14_PROMOTE';
UPDATE motor_actions SET description='Criar uma sessão de análise, enviar a solicitação e aguardar sua conclusão' WHERE code='A15_ANALYSIS_SESSION';
UPDATE motor_actions SET description='Criar uma sessão de desenvolvimento, enviar a solicitação e aguardar sua conclusão' WHERE code='A16_DEV_SESSION';
UPDATE motor_actions SET description='Verificar os commits da promoção e marcar a validação como aprovada' WHERE code='A17_VALIDATE_PROMOTION';
UPDATE motor_actions SET description='Remover e recriar o worktree, instalar dependências e registrar a recuperação' WHERE code='A18_RECOVER_WORKSPACE';
UPDATE motor_actions SET description='Interpretar a resposta do analista e marcar o plano como válido' WHERE code='A19_PARSE_REPLY';
UPDATE motor_actions SET description='Verificar o repositório e os caminhos permitidos, marcando o ambiente como válido' WHERE code='A20_PROBE_ENV';

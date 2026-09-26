# Validação da publicação de branch pelo Motor-v2

## Identificação da tarefa

| Item | Valor |
| --- | --- |
| Tarefa | `task-v2-bib-1787962293` |
| Projeto | `biblioteca-global` |
| Branch alvo | `base-desenvolvimento` |
| Motor | `MOTOR_VERSION=v2` |
| Porta da API | `3010` |
| Repositório | `/run/media/alexandre/12T/codigofonte/biblioteca-global` |

## Configuração do ambiente

- `MOTOR_VERSION=v2`.
- A API do Motor-v2 deve estar disponível na porta `3010`.
- `REPO_PATH` deve apontar diretamente para o diretório do repositório montado no
  container da API:
  `/run/media/alexandre/12T/codigofonte/biblioteca-global`.
- As credenciais e demais variáveis sensíveis devem existir somente no `.env`
  local. Nenhuma credencial deve ser registrada neste documento, no commit ou
  no payload da tarefa.
- A branch `base-desenvolvimento` deve existir e o checkout principal deve estar
  limpo antes da execução.

## Passos de validação

1. Iniciar a API com `MOTOR_VERSION=v2` e confirmar o health check:
   `GET http://localhost:3010/api/motor/health`.
2. Acionar o ciclo pelo pump do motor:
   `POST http://localhost:3010/api/motor/pump`.
3. Confirmar no log e no banco a aquisição do lock
   `project:biblioteca-global:execution`.
4. Confirmar a fase **PREPARE**: o motor deve usar
   `base-desenvolvimento` como base e criar um worktree isolado em uma branch
   exclusiva de trabalho.
5. Confirmar a fase **EXECUTE** e a criação, na raiz do workspace isolado, do
   arquivo `ciclo-test.txt` com exatamente:

   ```text
   Motor v2 ciclo completo OK.
   ```

6. Confirmar a fase **VERIFY** com sucesso em `npm run build` e `npm run test`.
7. Confirmar a fase **COMMIT**: o motor deve criar o commit técnico somente no
   worktree isolado e registrar seu SHA completo.
8. Confirmar a fase **PUBLISH**: o motor deve publicar somente o commit aprovado
   na branch remota de trabalho.
9. Conferir no remote a existência da branch de trabalho e validar que seu SHA
   é o mesmo SHA produzido na fase **COMMIT**.
10. Conferir na branch remota a existência de `ciclo-test.txt` com o conteúdo
    exato e confirmar que `base-desenvolvimento` não recebeu merge nem alteração.
11. Confirmar a liberação do lock e registrar os estados finais da tarefa e da
    subtarefa, além dos comandos, logs e SHA usados na validação, sem expor
    credenciais.

## Critérios de sucesso

O teste será considerado bem-sucedido quando todos os itens abaixo forem
verdadeiros:

- o health check responde com sucesso na porta `3010`;
- o worktree e a branch de trabalho são criados a partir de
  `base-desenvolvimento`, mantendo o checkout principal intacto;
- o lock por projeto é adquirido e liberado sem execução órfã;
- `ciclo-test.txt` contém exatamente `Motor v2 ciclo completo OK.`;
- `npm run build` e `npm run test` passam no workspace isolado;
- o commit técnico é criado depois da fase **VERIFY** e seu SHA é registrado;
- a branch remota de trabalho existe e aponta para o mesmo SHA do commit técnico;
- o arquivo e seu conteúdo são confirmados na branch remota;
- `base-desenvolvimento` não sofre merge, checkout ou escrita pelo worker;
- a tarefa e a subtarefa alcançam os estados finais de sucesso definidos pelo
  fluxo;
- a publicação não executa deploy, limpeza destrutiva ou publicação de pacote;
- a evidência da execução contém informações suficientes para auditoria sem
  incluir credenciais.

Qualquer falha em um desses itens torna o teste não aceito.

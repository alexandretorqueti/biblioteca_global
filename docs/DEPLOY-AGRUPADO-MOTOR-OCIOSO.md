# Deploy agrupado com o Motor ocioso

O Motor não publica mais uma tarefa imediatamente após sua integração. Tarefas
de desenvolvimento concluídas criam registros persistentes em
`deploy_requests`. O botão **Fazer deploy** usa a mesma fila.

## Regras

- A tarefa permanece `completed` enquanto o deploy estiver pendente.
- Nenhum lote começa enquanto existir worker, finalização, limpeza de worktree
  ou estado ativo de tarefa/subtarefa persistido no banco.
- Todas as solicitações pendentes do mesmo repositório entram em um único lote.
- O processo roda destacado no ServerIA e mantém o lock global com `flock`.
- Antes de recriar a API, o lote fica `running` no banco.
- O processo no host grava um marcador de sucesso ou falha em `/tmp`.
- Após reiniciar, o Motor reconcilia o marcador. Somente o sucesso muda as
  tarefas do lote para `deployed`.
- No boot e em cada ciclo, tarefas de desenvolvimento `completed` que ainda
  não possuem solicitação são recuperadas para a fila.
- Falha definitiva muda as tarefas do lote para `blocked`, registra o motivo
  em `ultima_mensagem_erro` e cria uma ocorrência em `bloqueios`. Uma tarefa
  bloqueada não entra novamente na fila automaticamente.
- Um lote sem marcador por 30 minutos é encerrado como falha, evitando estado
  `running` permanente caso o processo remoto seja interrompido.

Assim, a perda da memória do processo durante a recriação da API não perde o
estado da publicação e vários trabalhos concluídos podem ser publicados juntos.

## Configuração do deploy por projeto

A tabela `projeto_motor_config` permite configurar o script de deploy e o caminho
do repositório no host de forma individual para cada projeto.

### Campos

#### `deploy_script`

- **Tipo:** `varchar(500) NULL`
- **Convenção:** Caminho **relativo** ao *toplevel* do Git do repositório do projeto
- **Exemplo:** `"scripts/deploy.sh"` (considerando o repositório como raiz)
- **NULL (padrão):** Usa o script do Motor (`motor.deploy_script` na configuração global)
- **Validação antecipada:** Se declarado e o arquivo não existir no path verificado,
  o lote falha imediatamente com mensagem explícita (script, projeto, caminho completo)
  — não aguarda o timeout de 30 minutos.

#### `deploy_host_root`

- **Tipo:** `varchar(500) NULL`
- **Convenção:** Caminho absoluto do repositório no host para operações SSH
- **Exemplo:** `"/home/alexandre/codigofonte/minha-aplicacao"`
- **NULL (padrão):** Usa `DEPLOY_REPO_HOST` (variável de ambiente) ou `motor.deploy_host_root` (configuração global)
- **Quando usar:** Quando o caminho do repositório no host differ do caminho visto pelo container (ex.: worktrees do openclaw)

### Regras de deploy agrupado com scripts diferentes

- Um lote agrupa tarefas **do mesmo repositório** (mesmo `repo_path`).
- Se tarefas de projetos com `deploy_script` diferentes tentarem entrar no mesmo lote,
  o Motor **não mistura** — cada projeto mantém seu script individual.
- Na prática, isso quer dizer que cada repositório pode ter seu próprio script de deploy,
  definido no campo `deploy_script` da respectiva linha de `projeto_motor_config`.

### Exemplos de configuração

| Projeto | `deploy_script` | `deploy_host_root` | Comportamento |
|---------|----------------|-------------------|---------------|
| `biblioteca-global` | `NULL` | `NULL` | Usa script padrão do Motor e `DEPLOY_REPO_HOST` |
| `gerenteagentes` | `NULL` | `NULL` | Usa script padrão do Motor e `DEPLOY_REPO_HOST` |
| `sistema-adm-global` | `NULL` | `NULL` | Usa script padrão do Motor e `DEPLOY_REPO_HOST` |
| `taqui` | `NULL` | `NULL` | Usa script padrão do Motor e `DEPLOY_REPO_HOST` |
| `app-externa` | `"scripts/deploy.sh"` | `"/opt/myapp/repo"` | Usa script específico da app-externa e caminho do host personalizado |

### Tabela de configuração

```sql
-- Schema da tabela projeto_motor_config (excerto relevante)
ALTER TABLE projeto_motor_config
ADD COLUMN deploy_script varchar(500) NULL COMMENT 'Caminho relativo ao toplevel Git do repositório do projeto; NULL = script padrão do Motor',
ADD COLUMN deploy_host_root varchar(500) NULL COMMENT 'Caminho do repositório no host para SSH, quando diferir do caminho visto pelo container; NULL = DEPLOY_REPO_HOST';
```

### Tela de configuração

Os campos `deploy_script` e `deploy_host_root` são exibidos na tela de **Configuração do Motor**
do projeto com labels e `helperText` claros:

- **Script de deploy (opcional):** "Caminho relativo ao toplevel Git do repositório do projeto. Deixe vazio para usar o deploy padrão do Motor."
- **Raiz do host (opcional):** "Caminho do repositório no host para SSH, quando diferir do caminho visto pelo container. Deixe vazio para usar DEPLOY_REPO_HOST."

EOF
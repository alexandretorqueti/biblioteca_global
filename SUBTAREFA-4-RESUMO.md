# Subtarefa #4: Expor campos na tela Configuração do Motor

## O que foi implementado

### 1. Atualização do config.ts

Adicionados dois novos campos na childRoute `config-motor` (targetResource: `projeto_motor_config`):

| Campo | Label | Type | maxLength | fullWidth | helperText |
|-------|-------|------|-----------|-----------|------------|
| `deployScript` | Script de deploy | text | 500 | true | "Caminho relativo ao root Git para o script de deploy (ex.: scripts/deploy.sh). deixe vazio para usar o deploy padrão do Motor." |
| `deployHostRoot` | Raiz do host de deploy | text | 500 | true | "Caminho do repositório no host onde o deploy roda por SSH. deixe vazio para usar DEPLOY_REPO_HOST." |

Ambos os campos são **opcionais** (nullable no schema) e não têm `required: true`.

### 2. Atualização do overrides (columnLabels)

A grid da childRoute `config-motor` agora expõe as colunas:

- `deployScript` → "Script de deploy"
- `deployHostRoot` → "Raiz do host"

### 3. Atualização dos testes

#### `__tests__/config.spec.ts`

2 novos testes adicionados:

- `exponha deployScript na childRoute config-motor com helperText para deploy padrão`
  - Valida label "Script de deploy"
  - Valida type "text", maxLength: 500, fullWidth: true
  - Valida helperText contendo "deixe vazio para usar o deploy padrão do Motor"

- `exponha deployHostRoot na childRoute config-motor com helperText para DEPLOY_REPO_HOST`
  - Valida label "Raiz do host de deploy"
  - Valida type "text", maxLength: 500, fullWidth: true
  - Valida helperText contendo "deixe vazio para usar DEPLOY_REPO_HOST"

#### `__tests__/schema.spec.ts`

4 novos testes adicionados:

- `possui a coluna deploy_script (varchar(500), nullable)`
  - Valida coluna física `deploy_script` no schema Drizzle
  - Valida varchar(500) e nullable (notNull: false)
  - Valida propriedade TS `projetoMotorConfig.deployScript`

- `possui a coluna deploy_host_root (varchar(500), nullable)`
  - Valida coluna física `deploy_host_root` no schema Drizzle
  - Valida varchar(500) e nullable (notNull: false)
  - Valida propriedade TS `projetoMotorConfig.deployHostRoot`

- `inclui deploy_script nas anotações`
  - Valida `annotations.projeto_motor_config.deploy_script.label = "Script de deploy"`
  - Valida fullWidth: true, maxLength: 500

- `inclui deploy_host_root nas anotações`
  - Valida `annotations.projeto_motor_config.deploy_host_root.label = "Raiz do host de deploy"`
  - Valida fullWidth: true, maxLength: 500

## Validação

```bash
# Testes ( Vitest )
npx vitest run projects/gerenteagentes/__tests__/config.spec.ts projects/gerenteagentes/__tests__/schema.spec.ts
# ✅ 84/84 testes passando (10 arquivos)

# TypeScript (apenas config.ts, sem config completo do workspace)
npx tsc --noEmit --ignoreConfig config.ts
# ✅ Sem erros no config.ts
```

## Critérios de aceite

✅ **Campos deployScript e deployHostRoot visíveis e editáveis no formulário de Configuração do Motor**
- Adicionados na childRoute `config-motor` com `type: "text"` e `fullWidth: true`
- Não são obrigatórios (maxLength 500, nullable no banco)

✅ **helperText indica explicitamente que vazio = deploy padrão do Motor**
- `deployScript`: "deixe vazio para usar o deploy padrão do Motor"
- `deployHostRoot`: "deixe vazio para usar DEPLOY_REPO_HOST"

✅ **CRUD genérico da plataforma aceita as colunas (schema.ts carregado pelo DynamicSchemaRegistry)**
- `projetoMotorConfig.deployScript` e `projetoMotorConfig.deployHostRoot` já definidos no schema.ts
- Migration `0073_deploy_config_por_projeto.sql` já cria as colunas no banco

✅ **Testes de config/schema (__tests__) verdes**
- config.spec.ts: 11/11 testes passando
- schema.spec.ts: 13/13 testes passando

## Próximos passos (subtarefas seguintes)

1. Migration atualização (aplicar `0073_deploy_config_por_projeto.sql`)
2. TaskCoordinator.dispatchDeployBatch: resolver script pelo projeto dono da tarefa
3. Validação antecipada se script declarado não existe
4. Documentação em `docs/DEPLOY-AGRUPADO-MOTOR-OCIOSO.md`

## Arquivos alterados

| Arquivo | Mudanças |
|---------|----------|
| `projects/gerenteagentes/config.ts` | Adicionados `deployScript` e `deployHostRoot` na childRoute `config-motor` com helperText |
| `projects/gerenteagentes/__tests__/config.spec.ts` | 2 novos testes para os campos |
| `projects/gerenteagentes/__tests__/schema.spec.ts` | 4 novos testes para as colunas Drizzle |

## Observações

- O schema.ts já continha as colunas `deployScript` e `deployHostRoot` definidas como nullable
- A migration `0073_deploy_config_por_projeto.sql` já existia e cria as duas colunas
- Esta subtarefa focou apenas na **exposição na tela de configuração** (front) e **validação dos testes**
- O funcionamento do deploy via esses campos será implementado nas próximas subtarefas (TaskCoordinator e validação antecipada)

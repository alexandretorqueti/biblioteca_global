# Integração do AgentStatusStrip no OperationMapScreen

## Resumo

O componente `AgentStatusStrip` foi integrado ao topo do Mapa de agentes (`OperationMapScreen`) para exibir uma faixa responsiva com a representação visual animada dos três agentes: **Analista**, **Desenvolvedor** e **Gerente/Monitor**.

## Arquivos Modificados

### 1. `screens/AgentStatusStrip.tsx`
- **Correção de bug**: A variável `agentactivities` (minúsculo) foi corrigida para `agentActivities` (camelCase).
- **Mapeamento de workers**: O componente agora usa os `workers` do motor v3 para determinar o status de cada agente.
- **Novos props**: `workers?: Array<{ role: "analyst" | "developer" | "manager", active: boolean, model?: string | null, taskId?: string | null, phase?: string | null }>`
- **Lógica de status**: O status de cada agente é determinado com base no worker correspondente:
  - `idle`: worker inativo
  - `working`: worker ativo em tarefa normal
  - `deploying`: worker ativo em deploy

### 2. `screens/OperationMapScreen.tsx`
- **Add states**:
  - `motorStatus: "idle" | "working" | "deploying"`
  - `motorModel: string | null`
  - `motorTaskInfo: { taskId: number; title: string } | null`
- **Atualização de `loadActivity`**: Agora captura `workers`, `motorStatus`, `motorModel` e `motorTaskInfo` do endpoint `/gerenteagentes/motor-activity`.
- **Integração**: `<AgentStatusStrip>` adicionado no topo do JSX, logo após o Stack com o título "Mapa de agentes".

### 3. `screens/__tests__/OperationMapScreen.test.tsx`
- Atualizado para incluir `{ workers: [] }` no response do endpoint `/gerenteagentes/motor-activity`.

### 4. `screens/__tests__/OperationMapScreen.selection.test.tsx`
- Atualizado para incluir `{ workers: [] }` no response do endpoint `/gerenteagentes/motor-activity`.

## Estrutura de Dados da API

O endpoint `/gerenteagentes/motor-activity` agora retorne:

```typescript
{
  activities: MotorActivity[],           // Atividades históricas (compatibilidade legada)
  motorStatus: "idle" | "working" | "deploying",
  motorModel: string | null,
  motorTaskInfo: { taskId: number; title: string } | null,
  workers: [
    {
      role: "analyst" | "developer" | "manager",
      active: boolean,
      model: string | null,
      taskId: string | null,
      phase: string | null
    },
    // ... 3 workers no total
  ]
}
```

## Funcionalidades do AgentStatusStrip

### Visualização dos Agentes

Cada agente exibe:
- **Ícone**: AccountCircleRounded (Analista), CodeRounded (Desenvolvedor), SupervisedUserCircleRounded (Gerente/Monitor)
- **Nome**: "Analista", "Desenvolvedor", "Monitor"
- **Modelo**: Nome do modelo em uso (ex: "deepseek/deepseek-v4-flash")
- **Estado visual**:
  - Inativo: estado "idle" com cor desbotada
  - Ativo: animação "ripple" quando em `working` ou `deploying`

### Estado do Motor

Uma seção separada exibe o estado do motor:
- **Ícone**: PlayArrowRounded (operando), PauseRounded (pausado), ModelTrainingRounded (deploy)
- **Texto**: "Operando", "Motor pausado", "Deploy em andamento", etc.
- **Badge**: Exibe o ID da tarefa relacionada quando o motor está ativo

### Responsividade

- Tamanho pequeno (xs): ícones menores (16px), margens reduzidas
- Tamanho médio (sm): ícones 20px
- Flex-wrap garante que não haja overflow horizontal em telas pequenas

### Acessibilidade

- `aria-label` em cada agente: `{nome} — {role}`
- `aria-hidden="true"` nos indicadores de status decorativos
- Cores com contraste suficiente para acessibilidade
- Texto descritivo em todas as áreas

## Configuração do Motor v3

O motor v3 já fornece os dados de `workers` no endpoint `/api/motor/stats`:

```typescript
interface WorkerActivity {
  role: "analyst" | "developer" | "manager"
  active: boolean
  model: string | null
  executionId: string | null
  taskId: string | null
  subtaskId: number | null
  phase: string | null
  startedAt: number | null
  lastHeartbeat: number | null
}
```

O backend do gerenteagentes já projeta o `workerActivity` do motor v3 para o topo do objeto, então o `workers` está disponível no response de `/gerenteagentes/motor-activity`.

## Próximos Passos (Opcional)

1. **Testes de componente**: Criar testes específicos para `AgentStatusStrip`:
   - Renderização de 3 agentes
   - Estados: idle vs working vs deploying
   - Modelos sendo exibidos
   - Responsividade em breakpoints xs/sm/md

2. **Testes de integração**: Verificar que o componente é renderizado corretamente no `OperationMapScreen`.

3. **Ajustes visuais**: Ajustar cores, tamanhos ou animações com base no feedback do usuário.

## Conformidade com Requisitos

✅ Faixa no topo do Mapa de agentes
✅ Três agentes representados visualmente
✅ Analista, Desenvolvedor e Monitor (Gerente)
✅ Animação quando o agente está ativo
✅ Nome do modelo exibido ao lado do agente ativo
✅ Estado "Inativo" quando não há atividade
✅ Ícone de motorzinho (parado/rodando) no estado do motor
✅ Tarefa relacionada exibida no badge
✅ Responsividade (sem overflow horizontal em telas pequenas)
✅ Acessibilidade (labels, contraste, textos descritivos)
✅ Preservar mudanças existentes
✅ Sem push/deploy (apenas development)

::DONE::

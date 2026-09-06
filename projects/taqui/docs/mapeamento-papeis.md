# Mapeamento de Papéis do TaQui ao Perfil da Biblioteca

## Visão geral

| Papel de domínio TaQui | Valor `Perfil` (enum) | Acesso permitido |
|---|---|---|
| Síndico / dono do condomínio | `admin` | Full — CRUD em todos os recursos, ações operacionais |
| Gerente / administrador secundário | `gerente` | CRUD em todos os recursos, ações operacionais |
| Portaria / triagem | `operador` | Leitura completa + escrita de encomendas/ocorrências; NÃO pode gerenciar usuários ou config |
| Morador (residente) | `visualizador` | Apenas leitura das próprias encomendas e notificações |

## Mapeamento detalhado por módulo

### 1. Encomendas Registro (portaria/triagem)

| Rota HTTP | Método | `@Roles()` necessário | Perfil atual | Observação |
|---|---|---|---|---|
| `POST /:slug/encomendas-registro` | POST | Sim → `admin, gerente, operador` | ✅ Set | Apenas escritura exige role |
| `GET /:slug/encomendas-registro/unidades` | GET | Não (leitura universal dentro do scope) | ✅ OK | Isolado por ProjectScopeGuard |
| `GET /:slug/encomendas-registro/transportadoras` | GET | Não (leitura universal dentro do scope) | ✅ OK | Isolado por ProjectScopeGuard |

### 2. Encomendas Morador

| Rota HTTP | Método | `@Roles()` necessário | Perfil atual | Observação |
|---|---|---|---|---|
| `GET /:slug/encomendas/morador` | GET | Não (leitura; service filtra por usuário) | ✅ OK | Apenas as unidades do morador são retornadas |
| `PATCH /:slug/encomendas/:id/confirmar-reconhecimento` | PATCH | **Recomendado**: `visualizador, admin, gerente, operador` | ❌ Ausente | Ação do morador — deveria aceitar visualizador explicitamente |

### 3. Painel Portaria

| Rota HTTP | Método | `@Roles()` necessário | Perfil atual | Observação |
|---|---|---|---|---|
| `GET /:slug/painel-portaria/encomendas` | GET | Não (leitura; service filtra por scope) | ✅ OK | Isolado por ProjectScopeGuard |
| `GET /:slug/painel-portaria/encomendas/:id` | GET | Não (leitura; service filtra por scope) | ✅ OK | Detalhe também isolado por scope |
| `POST /:slug/painel-portaria/encomendas/:id/entregar` | POST | Sim → `admin, gerente, operador` | ✅ Set | Escritura exige role |
| `POST /:slug/painel-portaria/encomendas/:id/reenviar-aviso` | POST | Sim → `admin, gerente, operador` | ✅ Set | |

### 4. Ocorrências

| Rota HTTP | Método | `@Roles()` necessário | Perfil atual | Observação |
|---|---|---|---|---|
| `POST /:slug/ocorrencias` | POST | Sim → `admin, gerente, operador` | ✅ Set | |
| `GET /:slug/ocorrencias` | GET | Não (leitura; service filtra por scope) | ✅ OK | |
| `GET /:slug/ocorrencias/encomenda/:encomendaId` | GET | Não (leitura; serviço filtra) | ✅ OK | |

### 5. Notificações Morador

| Rota HTTP | Método | `@Roles()` necessário | Perfil atual | Observação |
|---|---|---|---|---|
| `GET /:slug/notificacoes/morador` | GET | Não (leitura; service filtra por usuário) | ✅ OK | Apenas notificações do morador autenticado |
| `PATCH /:slug/notificacoes/:id/marcar-lida` | PATCH | **Recomendado**: `visualizador, admin, gerente, operador` | ❌ Ausente | Ação do morador — deveria aceitar visualizador explicitamente |

### 6. CRUD genérico (todos os cadastros)

| Rota HTTP | Método | `@Roles()` necessário | Perfil atual | Observação |
|---|---|---|---|---|
| GET /:slug/:resource, :id | GET | Não (leitura; service filtra por scope) | ✅ OK | |
| POST /:slug/:resource | POST | Sim → `admin, gerente, operador` | ✅ Set | Via CrudController |
| PUT /:slug/:resource/:id | PUT | Sim → `admin, gerente, operador` | ✅ Set | Via CrudController |
| DELETE /:slug/:resource/:id | DELETE | Sim → `admin, gerente, operador` | ✅ Set | Via CrudController |

## Resumo do estado atual

**✅ OK (sem mudanças necessárias)** — Todos os endpoints de escrita já têm `@Roles("admin", "gerente", "operador")`. Endpoints GET dependem exclusivamente de:
1. **JwtAuthGuard** — autenticação obrigatória
2. **ProjectScopeGuard** — isola por condomínio (violação = 403)
3. **Service-level filtering** — filtra resultados pelo contexto do usuário

**⚠️ Ação recomendada:** Adicionar `@Roles("visualizador", "admin", "gerente", "operador")` aos PATCHs de encomendas-morador e notificações-morador para deixar explícito que `visualizador` também pode confirmar reconhecimento. Atualmente funciona porque o guard permite todas as perfis quando `@Roles()` é omitido, mas isso quebra a defesa em profundidade se alguém remove os guards do UseGuards no futuro.

## Constante ROLES_KEY

- **Valor atual:** `"***"` (placeholder)
- **Recomendado:** `"roles"` para legibilidade e debugging

## Navegação frontend por perfil

A aba "Ações Rápidas" (`telas-especiais`) contém:
- `taqui-registro-encomenda` — para portaria/triagem
- `taqui-painel-portaria` — para portaria
- `taqui-notificacoes-morador` (via Minhas Encomendas) — para morador

A filtragem por papel no frontend deve ocultar itens não pertinentes ao perfil atual do usuário. O backend já protege as rotas, mas a visibilidade na UI deve seguir o mapeamento:
- `admin`/`gerente` → vê todas as ações rápidas
- `operador` → vê "Registrar Encomenda" e "Painel da Portaria"
- `visualizador` → vê apenas "Minhas Encomendas"

## Notas de segurança

- Nenhum endpoint TaQui permite acesso entre condomínios — o `ProjectScopeGuard` resolve isso.
- Tentativas de acesso com perfil não autorizado retornam **403 Forbidden**.
- A confirmação de reconhecimento pelo morador é uma ação de escrita que deveria explicitamente aceitar o perfil `visualizador`.

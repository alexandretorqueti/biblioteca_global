# Contrato Técnico — Ações Rápidas do TaQui

> **Versão:** 1.0.0  
> **Data:** 2026-09-03  
> **Status:** Contrato operacional — base para implementação das telas custom

---

## 1. Visão Geral

Este documento define o contrato de domínio, API e permissões para as **5 ações operacionais** do TaQui. Cada ação especifica endpoint HTTP, payload (Zod), resposta, regra de autorização por papel, pré-condição de status, transição resultante e erros esperados.

### Princípios inegociáveis

| # | Princípio | Implicação |
|---|-----------|------------|
| P1 | **Isolamento multi-condomínio** | O `condominioId` vem **exclusivamente do token** (contexto de autenticação). O payload da requisição **nunca** contém ou sobrescreve `condominioId`. |
| P2 | **Fonte única de verdade** | `schema.ts` define tabelas, enums e relações. Migrations, validação Zod e config JSON são derivados. |
| P3 | **Transições atômicas** | Mudança de status é operação atômica com verificação de pré-condição. Sem caminho de API que entregue encomenda pendente ou cancelada. |
| P4 | **Rastreabilidade** | Toda alteração de status registra quem fez, quando e por quê. Ocorrência/devolução nunca é só mudança de status. |
| P5 | **Sem dependência externa nova** | Sem justificativa e verificação de solução interna. |

---

## 2. Papéis Operacionais

| Papel | Descrição | Escopo de dados |
|-------|-----------|-----------------|
| **triagem** | Funcionário que recebe, fotografa e registra encomendas | Encomendas do seu condomínio |
| **portaria** | Funcionário que controla a saída física das encomendas | Encomendas do seu condomínio |
| **ambos** | Funcionário com permissões de triagem + portaria | Encomendas do seu condomínio |
| **sindico/admin** | Síndico ou administrador do sistema | Todos os dados do seu condomínio; leitura transversal |
| **morador** | Residente vinculado a uma unidade | Apenas encomendas da(s) unidade(s) vinculadas |

### Mapeamento de papéis para `funcionarios.funcao`

| Valor no schema | Papel efetivo |
|-----------------|---------------|
| `triagem` | Pode registrar encomendas, confirmar reconhecimento (se atuando como portaria não — ver matriz) |
| `portaria` | Pode registrar entrega, reenviar notificação |
| `ambos` | Herda permissões de triagem + portaria |

> **Nota:** O papel é determinado pelo `funcionarioId` no token (JWT). Para o morador, o papel é determinado pelo `moradorId` no token. Para o síndico/admin, pelo `condominioId` + claim de admin.

---

## 3. Matriz de Transições de Status

### 3.1 Diagrama de estados

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
  [registro] ──► PENDENTE ──► CONFIRMADA ──► ENTREGUE             │
                    │              │                                │
                    │              │                                │
                    └──────┬───────┘                                │
                           │                                        │
                           ▼                                        │
                      CANCELADA ◄───────────────────────────────────┘
                      (com motivo)
```

### 3.2 Matriz completa

| Status origem | → pendente | → confirmada | → entregue | → cancelada |
|---------------|:----------:|:------------:|:----------:|:-----------:|
| **pendente** | — (idempotente) | ✅ Confirmar recebimento | ❌ INVÁLIDO | ✅ Ocorrência/devolução |
| **confirmada** | ❌ INVÁLIDO | — (idempotente) | ✅ Registrar entrega | ✅ Ocorrência/devolução |
| **entregue** | ❌ INVÁLIDO | ❌ INVÁLIDO | — (idempotente) | ❌ INVÁLIDO (entregue é terminal) |
| **cancelada** | ❌ INVÁLIDO | ❌ INVÁLIDO | ❌ INVÁLIDO | — (idempotente) |

### 3.3 Regras de transição

- **pendente → confirmada:** morador confirma que reconhece a encomenda (não significa retirada física).
- **confirmada → entregue:** funcionário registra a retirada física com evidência completa.
- **pendente → cancelada:** ocorrência/devolução com motivo obrigatório.
- **confirmada → cancelada:** ocorrência/devolução com motivo obrigatório; desfaz a confirmação do morador.
- **entregue → qualquer:** **BLOQUEADO**. Status entregue é terminal. Se houve erro, criar nova ocorrência vinculada sem alterar o status da encomenda original.
- **cancelada → qualquer:** **BLOQUEADO**. Status cancelada é terminal.

---

## 4. Ações — Contrato Detalhado

---

### 4.1 Ação: Registrar Encomenda

**Descrição:** Funcionário de triagem registra nova encomenda com foto, loja e unidade destino.

| Campo | Valor |
|-------|-------|
| **Endpoint** | `POST /api/encomendas` |
| **Método** | `POST` |
| **Papel autorizado** | `triagem`, `ambos` |
| **Status resultante** | `pendente` (sempre) |
| **Pré-condição** | Unidade e transportadora devem existir e estar ativas no condomínio |

#### Payload (Zod)

```typescript
const registrarEncomendaPayload = z.object({
  unidadeId: z.number().int().positive(),
  transportadoraId: z.number().int().positive().optional(),
  codigoRastreamento: z.string().max(100).optional(),
  fotoUrl: z.string().url().max(1000),
  observacoes: z.string().max(2000).optional(),
})
```

> **Nota:** `condominioId` **NÃO** está no payload — vem do token.

#### Response (201 Created)

```typescript
{
  id: number
  status: "pendente"
  condominioId: number        // do token
  unidadeId: number
  transportadoraId: number | null
  registradoPorId: number     // do token (funcionarioId)
  codigoRastreamento: string | null
  fotoUrl: string
  observacoes: string | null
  confirmadoPorId: null
  confirmadoEm: null
  entreguePorId: null
  entregueEm: null
  createdAt: string           // ISO 8601
  updatedAt: string           // ISO 8601
}
```

#### Efeitos colaterais

1. Cria notificação tipo `encomenda_pendente` para todos os moradores ativos da unidade.
2. Notificação push (sininho) enviada.

#### Erros esperados

| HTTP | Código | Condição |
|------|--------|----------|
| 400 | `VALIDATION_ERROR` | Payload inválido (fotoUrl obrigatória, unidadeId inexistente) |
| 403 | `FORBIDDEN` | Papel incompatível (morador, portaria sem funcao=ambos) |
| 404 | `UNIDADE_NOT_FOUND` | Unidade não existe ou não pertence ao condomínio do token |
| 404 | `TRANSPORTADORA_NOT_FOUND` | Transportadora informada não existe ou está inativa |
| 409 | `UNIDADE_INACTIVE` | Unidade está inativa |

---

### 4.2 Ação: Confirmar Recebimento (Reconhecimento pelo Morador)

**Descrição:** Morador confirma que está ciente da encomenda. Isso **não** significa retirada física — apenas reconhecimento.

| Campo | Valor |
|-------|-------|
| **Endpoint** | `PUT /api/encomendas/:id/confirmar` |
| **Método** | `PUT` |
| **Papel autorizado** | `morador` (apenas da unidade vinculada) |
| **Status origem** | `pendente` |
| **Status resultante** | `confirmada` |
| **Pré-condição** | Encomenda status = `pendente`; morador vinculado à unidade da encomenda |

#### Payload (Zod)

```typescript
const confirmarRecebimentoPayload = z.object({
  // Vazio — o morador é identificado pelo token
})
```

> O `moradorId` vem do token. A API valida que o morador pertence à unidade da encomenda.

#### Response (200 OK)

```typescript
{
  id: number
  status: "confirmada"
  confirmadoPorId: number       // moradorId do token
  confirmadoEm: string          // ISO 8601 — data/hora da confirmação
  // demais campos inalterados
}
```

#### Efeitos colaterais

1. Cria notificação tipo `encomenda_confirmada` para o morador que confirmou.
2. Encomenda fica disponível para retirada na portaria.

#### Erros esperados

| HTTP | Código | Condição |
|------|--------|----------|
| 403 | `FORBIDDEN` | Papel incompatível (funcionário tentando confirmar como morador) |
| 403 | `NOT_UNIT_RESIDENT` | Morador do token não está vinculado à unidade da encomenda |
| 404 | `ENCOMENDA_NOT_FOUND` | Encomenda não existe ou não pertence ao condomínio do token |
| 409 | `INVALID_TRANSITION` | Status atual não é `pendente` (já confirmada, entregue ou cancelada) |

---

### 4.3 Ação: Registrar Entrega

**Descrição:** Funcionário registra a retirada física da encomenda pelo morador (ou representante). Exige evidência completa.

| Campo | Valor |
|-------|-------|
| **Endpoint** | `PUT /api/encomendas/:id/entregar` |
| **Método** | `PUT` |
| **Papel autorizado** | `portaria`, `ambos` |
| **Status origem** | `confirmada` |
| **Status resultante** | `entregue` |
| **Pré-condição** | Encomenda status = `confirmada` |

#### Payload (Zod)

```typescript
const registrarEntregaPayload = z.object({
  /** Nome completo de quem retirou a encomenda. */
  recebedorNome: z.string().min(3).max(200),
  /** Documento de identificação de quem retirou (RG, CPF, etc.). */
  recebedorDocumento: z.string().max(30).optional(),
  /** Relação com o morador (caso não seja o próprio). */
  recebedorVinculo: z.enum(["proprio_morador", "familiar", "empregado", "terceiro"]).optional(),
  /** URL da foto do comprovante de retirada (documento assinado, foto do recebedor, etc.). */
  fotoComprovanteUrl: z.string().url().max(1000).optional(),
  /** PIN de confirmação (se o condomínio usar PIN — futuro). */
  pinRetirada: z.string().max(10).optional(),
  /** Observações sobre a entrega. */
  observacoesEntrega: z.string().max(1000).optional(),
})
```

> **Evidência obrigatória:** `recebedorNome` é obrigatório. Pelo menos um dos seguintes deve ser informado: `recebedorDocumento`, `fotoComprovanteUrl` ou `pinRetirada`.

#### Response (200 OK)

```typescript
{
  id: number
  status: "entregue"
  entreguePorId: number         // funcionarioId do token
  entregueEm: string            // ISO 8601 — data/hora da entrega
  entrega: {
    id: number
    encomendaId: number
    funcionarioId: number
    dataHoraEntrega: string     // ISO 8601
    evidenciaQuemRetirou: string // JSON stringificado com detalhes do recebedor
  }
}
```

#### Efeitos colaterais

1. Cria registro na tabela `entregas` com evidência completa.
2. Cria notificação tipo `encomenda_entregue` para o morador.
3. O campo `evidenciaQuemRetirou` da tabela `entregas` armazena JSON estruturado:

```json
{
  "recebedorNome": "João Silva",
  "recebedorDocumento": "123.456.789-00",
  "recebedorVinculo": "proprio_morador",
  "fotoComprovanteUrl": "https://...",
  "pinRetirada": null,
  "funcionarioNome": "Pedro (portaria)",
  "dataHora": "2026-09-03T14:30:00-03:00"
}
```

#### Erros esperados

| HTTP | Código | Condição |
|------|--------|----------|
| 400 | `VALIDATION_ERROR` | Payload inválido; nenhuma evidência mínima informada |
| 403 | `FORBIDDEN` | Papel incompatível (morador, triagem sem funcao=ambos) |
| 404 | `ENCOMENDA_NOT_FOUND` | Encomenda não existe ou não pertence ao condomínio do token |
| 409 | `INVALID_TRANSITION` | Status atual não é `confirmada` (pendente, entregue ou cancelada) |
| 409 | `ALREADY_DELIVERED` | Encomenda já foi entregue (status = entregue) |

---

### 4.4 Ação: Reenviar Notificação

**Descrição:** Funcionário reenvia notificação ao morador sobre encomenda pendente ou confirmada.

| Campo | Valor |
|-------|-------|
| **Endpoint** | `POST /api/encomendas/:id/reenviar-notificacao` |
| **Método** | `POST` |
| **Papel autorizado** | `triagem`, `portaria`, `ambos`, `sindico/admin` |
| **Pré-condição** | Encomenda status = `pendente` ou `confirmada` |

#### Payload (Zod)

```typescript
const reenviarNotificacaoPayload = z.object({
  /** Mensagem customizada (opcional — se omitida, usa template padrão). */
  mensagemCustom: z.string().max(500).optional(),
  /** Forçar envio para todos os moradores da unidade (default: apenas ativos). */
  incluirInativos: z.boolean().default(false),
})
```

#### Response (200 OK)

```typescript
{
  sucesso: true
  notificacoesCriadas: number
  notificacoes: Array<{
    id: number
    moradorId: number
    moradorNome: string
    tipo: "encomenda_pendente" | "encomenda_confirmada"
    mensagem: string
    createdAt: string
  }>
}
```

#### Erros esperados

| HTTP | Código | Condição |
|------|--------|----------|
| 400 | `VALIDATION_ERROR` | Payload inválido |
| 403 | `FORBIDDEN` | Papel incompatível (morador) |
| 404 | `ENCOMENDA_NOT_FOUND` | Encomenda não existe ou não pertence ao condomínio do token |
| 409 | `INVALID_STATUS` | Encomenda já entregue ou cancelada — não faz sentido reenviar |
| 409 | `NO_ACTIVE_RESIDENTS` | Unidade não possui moradores ativos para notificar |

---

### 4.5 Ação: Registrar Ocorrência / Devolução

**Descrição:** Registra ocorrência ou devolução de encomenda. **Nunca** é apenas mudança de status — exige motivo, responsável, data e evidência.

| Campo | Valor |
|-------|-------|
| **Endpoint** | `POST /api/encomendas/:id/ocorrencia` |
| **Método** | `POST` |
| **Papel autorizado** | `triagem`, `portaria`, `ambos`, `sindico/admin` |
| **Status origem** | `pendente` ou `confirmada` |
| **Status resultante** | `cancelada` |
| **Pré-condição** | Encomenda status = `pendente` ou `confirmada` |

#### Payload (Zod)

```typescript
const registrarOcorrenciaPayload = z.object({
  /** Tipo de ocorrência. */
  tipo: z.enum([
    "devolucao_transportadora",  // transportadora veio buscar
    "devolucao_morador",         // morador devolveu após retirada (não se aplica — só pendente/confirmada)
    "extravio",                  // encomenda perdida
    "recusada",                  // morador recusou
    "endereco_incorreto",        // unidade errada
    "outro",                     // requer descricaoObrigatoria
  ]),
  /** Motivo detalhado — obrigatório. */
  motivo: z.string().min(10).max(2000),
  /** Descrição livre adicional (obrigatória quando tipo=outro). */
  descricao: z.string().max(2000).optional(),
  /** URL da foto da evidência (foto da encomenda devolvida, dano, etc.). */
  fotoEvidenciaUrl: z.string().url().max(1000).optional(),
  /** Observações sobre a ocorrência. */
  observacoes: z.string().max(2000).optional(),
  /** Se a encomenda foi devolvida à transportadora. */
  devolvidaTransportadora: z.boolean().default(false),
  /** Data/hora da ocorrência (default: agora). */
  dataOcorrencia: z.string().datetime({ offset: true }).optional(),
})
```

> **Evidência obrigatória:** `motivo` (mínimo 10 caracteres) é sempre obrigatório. `fotoEvidenciaUrl` é obrigatória quando `tipo` = `extravio` ou `devolucao_transportadora`.

#### Response (200 OK)

```typescript
{
  id: number
  status: "cancelada"
  ocorrencia: {
    id: number
    encomendaId: number
    tipo: string
    motivo: string
    descricao: string | null
    fotoEvidenciaUrl: string | null
    observacoes: string | null
    devolvidaTransportadora: boolean
    dataOcorrencia: string          // ISO 8601
    registradoPorId: number         // funcionarioId do token
    condominioId: number            // do token
    createdAt: string
  }
}
```

#### Erros esperados

| HTTP | Código | Condição |
|------|--------|----------|
| 400 | `VALIDATION_ERROR` | Payload inválido; motivo muito curto; tipo=outro sem descricao |
| 400 | `EVIDENCIA_OBRIGATORIA` | tipo=extravio ou devolucao_transportadora sem fotoEvidenciaUrl |
| 403 | `FORBIDDEN` | Papel incompatível (morador) |
| 404 | `ENCOMENDA_NOT_FOUND` | Encomenda não existe ou não pertence ao condomínio do token |
| 409 | `INVALID_TRANSITION` | Status atual é `entregue` ou `cancelada` — transição bloqueada |

---

## 5. Tabela de Ocorrências (nova — requer migration)

Para dar rastreabilidade à ação 4.5, é necessária nova tabela no schema:

```typescript
export const ocorrencias = mysqlTable("ocorrencias", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  encomendaId: bigint("encomenda_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => encomendas.id, { onDelete: "restrict" }),
  condominioId: bigint("condominio_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => condominios.id, { onDelete: "cascade" }),
  registradoPorId: bigint("registrado_por_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => funcionarios.id, { onDelete: "restrict" }),
  tipo: mysqlEnum("tipo", [
    "devolucao_transportadora",
    "extravio",
    "recusada",
    "endereco_incorreto",
    "outro",
  ]).notNull(),
  motivo: varchar("motivo", { length: 2000 }).notNull(),
  descricao: text("descricao"),
  fotoEvidenciaUrl: varchar("foto_evidencia_url", { length: 1000 }),
  observacoes: text("observacoes"),
  devolvidaTransportadora: boolean("devolvida_transportadora").notNull().default(false),
  dataOcorrencia: timestamp("data_ocorrencia").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (table) => [
  index("idx_ocorrencias_encomenda_id").on(table.encomendaId),
  index("idx_ocorrencias_condominio_id").on(table.condominioId),
])
```

> **Migration:** será gerada pelo `drizzle-kit` a partir da adição desta tabela ao `schema.ts`. Não quebra API pública existente.

---

## 6. Isolamento Multi-Condomínio

### Regra absoluta

O `condominioId` é extraído **exclusivamente** do token de autenticação em todas as ações:

```typescript
// Middleware de auth — exemplo conceitual
function getCondominioId(req: Request): number {
  const token = req.auth.token
  if (!token?.condominioId) {
    throw new ForbiddenError("Token sem contexto de condomínio")
  }
  return token.condominioId
}
```

### Implicações por ação

| Ação | Como o condomínio é resolvido |
|------|-------------------------------|
| Registrar encomenda | `condominioId` do token; `unidadeId` validado contra esse condomínio |
| Confirmar recebimento | `condominioId` do token; encomenda validada contra esse condomínio |
| Registrar entrega | `condominioId` do token; encomenda validada contra esse condomínio |
| Reenviar notificação | `condominioId` do token; encomenda validada contra esse condomínio |
| Registrar ocorrência | `condominioId` do token; encomenda validada contra esse condomínio |

### Validação cruzada

Em toda ação que recebe `:id` (encomendaId), a API **sempre** valida:

```sql
SELECT * FROM encomendas WHERE id = :id AND condominio_id = :condominioIdDoToken
```

Se não encontrar → `404 ENCOMENDA_NOT_FOUND`. Isso impede acesso transversal entre condomínios.

---

## 7. Resumo de Autorização por Ação

| Ação | triagem | portaria | ambos | síndico/admin | morador |
|------|:-------:|:--------:|:-----:|:-------------:|:-------:|
| Registrar encomenda | ✅ | ❌ | ✅ | ✅ (criação) | ❌ |
| Confirmar recebimento | ❌ | ❌ | ❌ | ❌ | ✅ (própria unidade) |
| Registrar entrega | ❌ | ✅ | ✅ | ✅ (leitura) | ❌ |
| Reenviar notificação | ✅ | ✅ | ✅ | ✅ | ❌ |
| Registrar ocorrência | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## 8. Códigos de Erro Padronizados

| HTTP Status | Código | Significado |
|-------------|--------|-------------|
| 400 | `VALIDATION_ERROR` | Payload não passou na validação Zod |
| 400 | `EVIDENCIA_OBRIGATORIA` | Ação exige evidência e não foi informada |
| 403 | `FORBIDDEN` | Papel do token não tem permissão para esta ação |
| 403 | `NOT_UNIT_RESIDENT` | Morador não vinculado à unidade da encomenda |
| 404 | `ENCOMENDA_NOT_FOUND` | Encomenda não existe ou não pertence ao condomínio |
| 404 | `UNIDADE_NOT_FOUND` | Unidade não existe ou não pertence ao condomínio |
| 404 | `TRANSPORTADORA_NOT_FOUND` | Transportadora não existe ou está inativa |
| 409 | `INVALID_TRANSITION` | Transição de status não permitida a partir do status atual |
| 409 | `ALREADY_DELIVERED` | Encomenda já entregue — ação não aplicável |
| 409 | `INVALID_STATUS` | Status atual não permite a ação solicitada |
| 409 | `UNIDADE_INACTIVE` | Unidade está inativa |
| 409 | `NO_ACTIVE_RESIDENTS` | Nenhum morador ativo para notificar |

---

## 9. Fluxo Completo — Sequência Típica

```
1. TRANSPORTADORA entrega pacote na portaria
2. TRIAGEM registra encomenda (POST /api/encomendas)
   → status: pendente
   → notificação enviada ao morador
   
3. MORADOR vê sininho e confirma recebimento (PUT /api/encomendas/:id/confirmar)
   → status: confirmada
   → notificação de confirmação
   
4. MORADOR vai à portaria retirar
5. PORTARIA identifica o morador e registra entrega (PUT /api/encomendas/:id/entregar)
   → status: entregue
   → registro na tabela entregas com evidência
   → notificação de entrega
   
--- OU ---

3b. ENCOMENDA não é retirada em X dias
4b. PORTARIA/SÍNDICO registra ocorrência (POST /api/encomendas/:id/ocorrencia)
   → status: cancelada
   → registro na tabela ocorrencias com motivo + evidência
   → devolução à transportadora se aplicável
```

---

## 10. Considerações de Implementação

### Ordem de implementação sugerida

1. **Schema + migration** — adicionar tabela `ocorrencias` (ação 4.5)
2. **Validação Zod** — schemas de payload para as 5 ações
3. **Middleware de auth** — extração de papel + condomínioId do token
4. **Handlers** — um handler por ação, seguindo o contrato
5. **Testes** — cobrir matriz de transições + erros
6. **Telas custom** — implementação React (fora do escopo deste contrato)

### Compatibilidade com API pública existente

- A ação "Registrar encomenda" (`POST /api/encomendas`) **já existe** como CRUD genérico. O contrato aqui **refina** a validação (exige fotoUrl, valida unidade contra condomínio do token) sem quebrar a API.
- As ações de confirmar, entregar, reenviar e ocorrência são **novos endpoints** que não conflitam com o CRUD existente.
- O campo `status` no CRUD genérico de encomendas deve ter sua edição direta **restrita** — transições só via endpoints específicos. O CRUD genérico pode manter o campo visível (leitura), mas a escrita direta de `status` deve ser bloqueada via `overrides.hiddenFields` ou guard de permissão.

### PIN / Assinatura / Foto de comprovante

O schema atual da tabela `entregas` já possui `evidenciaQuemRetirou` (text). O contrato especifica que esse campo armazena JSON estruturado com:
- `recebedorNome` (obrigatório)
- `recebedorDocumento` (opcional)
- `recebedorVinculo` (opcional)
- `fotoComprovanteUrl` (opcional)
- `pinRetirada` (opcional — futuro)

> **Decisão pendente:** PIN de retirada é recurso futuro. O campo está previsto no payload mas não é obrigatório nesta versão.

---

## 11. Glossário

| Termo | Significado |
|-------|-------------|
| **Triagem** | Setor que recebe e registra encomendas |
| **Portaria** | Setor que controla a saída física |
| **Confirmação** | Morador reconhece a encomenda (não retira fisicamente) |
| **Entrega** | Retirada física com evidência |
| **Ocorrência** | Registro de anomalia (devolução, extravio, recusa) |
| **Evidência** | Dados que comprovam a ação (nome, documento, foto, PIN) |

---

## 12. Changelog

| Versão | Data | Alteração |
|--------|------|-----------|
| 1.0.0 | 2026-09-03 | Contrato inicial — 5 ações, matriz de transições, tabela ocorrencias |

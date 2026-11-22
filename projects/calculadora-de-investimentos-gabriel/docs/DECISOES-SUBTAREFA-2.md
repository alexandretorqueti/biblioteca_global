# Decisões — Subtarefa 2 (schema `indices`, migrations e seed)

> Plano macro #6 — Calculadora de Investimentos Gabriel, posição 1/9.
> Registrado em 2026-11-20 pela DEV da subtarefa 2.

## 1. Ausência de docs/ESPEC-CRUD.md (fonte declarada na macro)

A macro aponta `docs/ESPEC-CRUD.md` como fonte de verdade de
`schema.ts`/`config.ts`, mas o arquivo **não existe** no repositório nem em
nenhum worktree (verificado em `setup-calculadora-de-investimentos-gabriel`).
Conforme instrução da própria subtarefa, os campos foram derivados de:

- `docs/ESPECIFICACAO.md` — entidade "Índice: nome, taxa atual (anual e
  mensal derivada), fonte da cotação" (seção Entidades de dados) e RF-3/RF-6;
- padrão `projects/voz-na-isa` (bootstrap mínimo de projeto da plataforma):
  estrutura de `schema.ts` + `annotations`, `drizzle.config.ts` com caminhos
  relativos e database via env, `package.json`/`tsconfig.json` de workspace.

Se a ESPEC-CRUD for publicada em subtarefa posterior, este schema deve ser
reconciliado com ela (migrations regeneradas pelo drizzle-kit, nunca à mão).

## 2. Modelo da tabela `indices`

- Colunas: `id`, `nome` (varchar 100, unique), `sigla` (varchar 20, unique),
  `taxa_anual` (decimal(9,4), % a.a.), `fonte_cotacao` (varchar 100),
  `ordem` (int, ordenação estável exigida pelo aceite), `created_at`,
  `updated_at` (padrão da plataforma).
- **Taxa mensal não é coluna**: RF-6 determina conversão automática
  anual→mensal por juros compostos — dado derivado, calculado na projeção
  (subtarefa posterior), não persistido.
- Cotação automática (SGS/BrasilAPI) atualiza `taxa_anual` em subtarefa
  própria; o seed carrega valores iniciais plausíveis.

## 3. Banco físico

- `projeto_8499` — id do projeto provisionado (core.projetos,
  slug `calculadora-de-investimentos-gabriel`, Gabriel vinculado como admin),
  default no `drizzle.config.ts` com override `CALCULADORA_GABRIEL_DATABASE` via env — mesma convenção de
  `VOZ_NA_ISA_DATABASE=projeto_8498`. Nunca senha em arquivo versionado.

## 4. Seed idempotente

- `seed-indices.ts`: `INSERT ... ON DUPLICATE KEY UPDATE` pela unique
  `indices_sigla_unica`; rodar 2x mantém 1 linha por sigla (CDI, Selic,
  IPCA, Ibovespa com `ordem` 1–4) e atualiza campos.

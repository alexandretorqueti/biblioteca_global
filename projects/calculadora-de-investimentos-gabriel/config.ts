/**
 * Config BASE versionada do projeto `calculadora-de-investimentos-gabriel`
 * (plano macro #6, posição 1/9 — REQ-F-001/REQ-D-003/REQ-NF-004/REQ-NF-005).
 *
 * Padrão `projects/voz-na-isa/config.ts` (GeradorSistemaConfig do
 * @biblioteca-global/shared): menu, rotas e telas como dado serializável —
 * nenhum HTTP aqui (PoC §7).
 *
 * Menu `Investimentos`:
 * - Índices → tela `cadastro` sobre o resource `indices` (listar/criar/
 *   editar/excluir via CRUD genérico da plataforma). Os `fields` repetem as
 *   labels das `annotations` do schema.ts (fonte única dos rótulos); a
 *   ordenação estável do seed é garantida por `defaultOrderBy: ordem asc`.
 * - Calculadora → rota custom `/calculadora` (kind `custom`, componentId
 *   resolvido pelo registry do front em `screens/registry.ts`). O placeholder
 *   NÃO faz cotação nem cálculo — projeção e cotação SGS pertencem a
 *   subtarefas posteriores deste plano (fora do escopo desta macro).
 *
 * Sincronização no core: `database/seed.ts` autodescobre esta config via
 * `descobrirProjetosSeed` e faz upsert em `projetos.config` por slug
 * (id 8499 provisionado na subtarefa 1). O registro do schema no
 * `DynamicSchemaRegistry` já decorre do `schema.ts` existir na pasta.
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "Calculadora de Investimentos Gabriel" },
  groups: [
    {
      id: "investimentos",
      label: "Investimentos",
      items: [
        {
          id: "indices-list",
          label: "Índices",
          path: "indices",
          icon: "table",
          screen: {
            kind: "cadastro",
            resource: "indices",
            title: "Índices",
            description:
              "Índices de mercado disponíveis na calculadora (CDI, Selic, IPCA, Ibovespa); a taxa mensal é derivada da anual",
            // Labels espelhando as annotations de schema.ts (fonte única).
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 100 },
              { name: "sigla", label: "Sigla", type: "text", required: true, maxLength: 20 },
              {
                name: "taxaAnual",
                label: "Taxa anual (% a.a.)",
                type: "number",
                min: 0,
                helperText: "Taxa anual vigente; a mensal é derivada automaticamente",
              },
              { name: "fonteCotacao", label: "Fonte da cotação", type: "text", maxLength: 100 },
              { name: "ordem", label: "Ordem", type: "number", helperText: "Ordenação na lista de índices" },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                nome: "Nome",
                sigla: "Sigla",
                taxaAnual: "Taxa anual (% a.a.)",
                fonteCotacao: "Fonte da cotação",
                ordem: "Ordem",
              },
              newLabel: "Novo índice",
            },
            defaultOrderBy: [{ campo: "ordem", direction: "asc" }],
          },
        },
        {
          id: "calculadora-view",
          label: "Calculadora",
          path: "calculadora",
          icon: "table",
          screen: {
            kind: "custom",
            componentId: "calculadora-de-investimentos-gabriel-calculadora",
          },
        },
      ],
    },
  ],
}

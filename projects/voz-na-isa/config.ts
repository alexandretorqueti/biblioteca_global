/**
 * Config BASE versionada do projeto `voz-na-isa` — PROVISÓRIA de setup
 * (bootstrap mínimo, sem plano macro aprovado).
 *
 * ⚠️ PROVISÓRIO — será substituído quando houver plano aprovado
 * (especificacaoCrud do plano macro; ver docs/ESPECIFICACAO.md). Esta config
 * NÃO deriva da descrição do produto: contém a única tela de cadastro da
 * tabela placeholder do schema.ts, exigida pelo bootstrap do setup. Sem telas
 * custom (2.3 não aplicável). A tela Usuários é injetada pela plataforma
 * (PoC §8). A config definitiva entra no core (projetos.config, id 8498) via
 * materialização do plano — enquanto isso o espelho versionado é esta pasta.
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "Voz na Isa" },
  groups: [
    {
      id: "voz",
      label: "Voz",
      items: [
        {
          id: "voz-configuracoes-list",
          label: "Configurações de voz",
          path: "voz_configuracoes",
          icon: "settings",
          screen: {
            kind: "cadastro",
            resource: "voz_configuracoes",
            title: "Configurações de voz",
            description:
              "Parâmetros de voz por escopo (bootstrap provisório — sem plano aprovado; nenhum áudio é persistido)",
            fields: [
              { name: "escopo", label: "Escopo", type: "text", required: true, maxLength: 100 },
              { name: "voz", label: "Voz", type: "text", required: true, maxLength: 100, defaultValue: "isadora" },
              { name: "idioma", label: "Idioma", type: "text", required: true, maxLength: 10, defaultValue: "pt-BR" },
              { name: "ativa", label: "Ativa", type: "switch", defaultValue: false },
              { name: "observacoes", label: "Observações", type: "textarea", fullWidth: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                escopo: "Escopo",
                voz: "Voz",
                idioma: "Idioma",
                ativa: "Ativa",
              },
              newLabel: "Nova configuração de voz",
            },
          },
        },
      ],
    },
  ],
}

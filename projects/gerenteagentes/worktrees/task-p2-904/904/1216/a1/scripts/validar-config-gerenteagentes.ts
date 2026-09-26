/**
 * One-off: valida a config do gerenteagentes contra o schema Zod
 * (mesma validação que o ProjectContext faz em runtime).
 */
import { geradorSistemaConfigSchema } from "../packages/shared/src/config"
import { config } from "../projects/gerenteagentes/config"

const resultado = geradorSistemaConfigSchema.safeParse(config)
if (!resultado.success) {
  console.error("CONFIG INVÁLIDA:")
  for (const issue of resultado.error.issues) {
    console.error(`- ${issue.path.join(".")}: ${issue.message}`)
  }
  process.exit(1)
}
console.log("Config OK — telas:", resultado.data.groups.length)
// dump resumido das grids (colunas visíveis por tela)
for (const grupo of resultado.data.groups) {
  for (const item of grupo.items) {
    if (item.screen.kind !== "cadastro") continue
    const visiveis = (item.screen.fields ?? [])
      .filter((f) => f.gridVisible !== false)
      .map((f) => f.name)
    console.log(`- ${item.label}: grid=[id, ${visiveis.join(", ")}]`)
    for (const rota of item.screen.childRoutes ?? []) {
      const visiveisFilho = (rota.fields ?? [])
        .filter((f) => f.gridVisible !== false)
        .map((f) => f.name)
      const ocultas = [...(rota.overrides?.hiddenColumns ?? []), ...(rota.fields ?? []).filter((f) => f.gridVisible === false).map((f) => f.name)]
      console.log(`  → ${rota.label} (${rota.targetResource}): grid=[id, ${visiveisFilho.join(", ")}] ocultas=${ocultas.join(",")} labels=${JSON.stringify(rota.overrides?.columnLabels ?? {})}`)
      for (const sub of rota.childRoutes ?? []) {
        const visiveisSub = (sub.fields ?? [])
          .filter((f) => f.gridVisible !== false)
          .map((f) => f.name)
        const ocultasSub = [...(sub.overrides?.hiddenColumns ?? []), ...(sub.fields ?? []).filter((f) => f.gridVisible === false).map((f) => f.name)]
        console.log(`    → ${sub.label} (${sub.targetResource}): grid=[id, ${visiveisSub.join(", ")}] ocultas=${ocultasSub.join(",")} labels=${JSON.stringify(sub.overrides?.columnLabels ?? {})}`)
      }
    }
  }
}

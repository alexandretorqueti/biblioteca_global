/**
 * registry.ts — telas custom do projeto `gestao-de-tarefas-global`.
 *
 * Contrato de autodescoberta (apps/web/src/project/registry/customScreens.tsx):
 * o glob de registry (projects/<slug>/screens/registry.ts — asterisco no lugar
 * de <slug>) importa ESTE arquivo em build time e agrega o export
 * `customScreens` (componentId → componente). Cada tela
 * também exporta seu próprio `componentId` — aqui usamos o valor exportado
 * pelas telas como única fonte (evita string solta).
 */
import type { CustomScreenComponent } from "@biblioteca-global/ui"

import TarefaFluxoScreen, {
  componentId as tarefaFluxoComponentId,
} from "./TarefaFluxoScreen"
import VisoesTarefasScreen, {
  componentId as visoesTarefasComponentId,
} from "./VisoesTarefasScreen"

export const customScreens: Record<string, CustomScreenComponent> = {
  [tarefaFluxoComponentId]: TarefaFluxoScreen,
  [visoesTarefasComponentId]: VisoesTarefasScreen,
}

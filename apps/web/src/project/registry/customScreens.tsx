/**
 * registry/customScreens.tsx — registro das telas custom dos projetos.
 *
 * Atualmente o único projeto que possui tela custom é "documentacao". A
 * implementação anterior registrava um placeholder genérico e, em seguida,
 * uma chave separada `docScreen`. O manual (§38) especifica que a configuração
 * do projeto referencia o componentId **"documentation"**; portanto devemos
 * registrar exatamente esse id com a tela real.
 */

import { registerCustomScreens } from "@biblioteca-global/ui"
import { SistemaAdmGlobalDashboard, SistemaAdmGlobalHubAdministrativo, SistemaAdmGlobalHubRh } from "../../screens/custom"
import DocumentationScreen from "../../../../../projects/documentacao/screens/DocumentationScreen"
import DashboardScreen from "../../../../../projects/gerenteagentes/screens/DashboardScreen"
import NovaTarefaScreen from "../../../../../projects/gerenteagentes/screens/NovaTarefaScreen"
import TaskMonitorScreen from "../../../../../projects/gerenteagentes/screens/TaskMonitorScreen"
import ModelSelectionScreen from "../../../../../projects/gerenteagentes/screens/ModelSelectionScreen"
import IsaChatScreen from "../../../../../projects/gerenteagentes/screens/IsaChatScreen"

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (main.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 */
export function registrarTelasCustom(): void {
  registerCustomScreens({
    documentation: DocumentationScreen,
    "gerenteagentes-dashboard": DashboardScreen,
    "gerenteagentes-nova-tarefa": NovaTarefaScreen,
    "gerenteagentes-task-monitor": TaskMonitorScreen,
    "gerenteagentes-model-selection": ModelSelectionScreen,
    "gerenteagentes-isa-chat": IsaChatScreen,
    "sistema-adm-global-dashboard": SistemaAdmGlobalDashboard,
    "sistema-adm-global-hub-administrativo": SistemaAdmGlobalHubAdministrativo,
    "sistema-adm-global-hub-rh": SistemaAdmGlobalHubRh,
  })
}

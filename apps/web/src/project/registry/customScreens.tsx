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
import { SistemaAdmGlobalDashboard, SistemaAdmGlobalHubAdmin, SistemaAdmGlobalHubAdministrativo, SistemaAdmGlobalHubRh } from "../../screens/custom"
import DocumentationScreen from "../../../../../projects/documentacao/screens/DocumentationScreen"
import DashboardScreen from "../../../../../projects/gerenteagentes/screens/DashboardScreen"
import NovaTarefaScreen from "../../../../../projects/gerenteagentes/screens/NovaTarefaScreen"
import TaskMonitorScreen from "../../../../../projects/gerenteagentes/screens/TaskMonitorScreen"
import ModelSelectionScreen from "../../../../../projects/gerenteagentes/screens/ModelSelectionScreen"
import IsaChatScreen from "../../../../../projects/gerenteagentes/screens/IsaChatScreen"
import PromptsScreen from "../../../../../projects/gerenteagentes/screens/PromptsScreen"
import PainelPortariaScreen from "../../../../../projects/taqui/screens/PainelPortariaScreen"
import NotificacoesMoradorScreen from "../../../../../projects/taqui/screens/NotificacoesMoradorScreen"
import RegistroEncomendaScreen from "../../../../../projects/taqui/screens/RegistroEncomendaScreen"

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
    "gerenteagentes-prompts": PromptsScreen,
    "sistema-adm-global-dashboard": SistemaAdmGlobalDashboard,
    "sistema-adm-global-hub-admin": SistemaAdmGlobalHubAdmin,
    "sistema-adm-global-hub-administrativo": SistemaAdmGlobalHubAdministrativo,
    "sistema-adm-global-hub-rh": SistemaAdmGlobalHubRh,
    "taqui-painel-portaria": PainelPortariaScreen,
    "taqui-notificacoes-morador": NotificacoesMoradorScreen,
    "taqui-registro-encomenda": RegistroEncomendaScreen,
  })
}

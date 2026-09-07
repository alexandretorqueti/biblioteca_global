import DashboardScreen, { componentId as dashboardId } from "./DashboardScreen"
import IsaChatScreen, { componentId as isaChatId } from "./IsaChatScreen"
import ModelSelectionScreen, { componentId as modelSelectionId } from "./ModelSelectionScreen"
import NovaTarefaScreen, { componentId as novaTarefaId } from "./NovaTarefaScreen"
import PromptsScreen, { componentId as promptsId } from "./PromptsScreen"
import TaskMonitorScreen, { componentId as taskMonitorId } from "./TaskMonitorScreen"

/** Registry exclusivo das telas customizadas do projeto gerenteagentes. */
export const customScreens = {
  [dashboardId]: DashboardScreen,
  [isaChatId]: IsaChatScreen,
  [modelSelectionId]: ModelSelectionScreen,
  [novaTarefaId]: NovaTarefaScreen,
  [promptsId]: PromptsScreen,
  [taskMonitorId]: TaskMonitorScreen,
}

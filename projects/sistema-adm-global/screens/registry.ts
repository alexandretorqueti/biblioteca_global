import DashboardScreen, { componentId as dashboardId } from "./sistema-adm-global-dashboard"
import HubAdminScreen, { componentId as hubAdminId } from "./sistema-adm-global-hub-admin"
import HubAdministrativoScreen, { componentId as hubAdministrativoId } from "./sistema-adm-global-hub-administrativo"
import HubRhScreen, { componentId as hubRhId } from "./sistema-adm-global-hub-rh"

/** Registry exclusivo das telas customizadas do projeto sistema-adm-global. */
export const customScreens = {
  [dashboardId]: DashboardScreen,
  [hubAdminId]: HubAdminScreen,
  [hubAdministrativoId]: HubAdministrativoScreen,
  [hubRhId]: HubRhScreen,
}

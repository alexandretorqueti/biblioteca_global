import LogsLoginScreen, { componentId as logsLoginId } from "./LogsLoginScreen"
import GlobalUsersScreen, { componentId as globalUsersId } from "./GlobalUsersScreen"
import WhatsAppChannelsScreen, { componentId as whatsappChannelsId } from "./WhatsAppChannelsScreen"

export const customScreens = {
  [logsLoginId]: LogsLoginScreen,
  [globalUsersId]: GlobalUsersScreen,
  [whatsappChannelsId]: WhatsAppChannelsScreen,
}

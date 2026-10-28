import LogsLoginScreen, { componentId as logsLoginId } from "./LogsLoginScreen"
import GlobalUsersScreen, { componentId as globalUsersId } from "./GlobalUsersScreen"

export const customScreens = {
  [logsLoginId]: LogsLoginScreen,
  [globalUsersId]: GlobalUsersScreen,
}

/**
 * Resolução de ícones por string (PoC §7.4): a config JSON carrega o NOME
 * do ícone (ex.: "dashboard"); o front resolve para o componente MUI.
 * O apps/web pode sobrescrever via GeradorSistemaRuntime.resolveIcon.
 */
import type { ReactNode } from "react"
import {
  DashboardRounded,
  DescriptionRounded,
  FolderRounded,
  GridViewRounded,
  GroupsRounded,
  HomeRounded,
  ListAltRounded,
  ManageAccountsRounded,
  PeopleRounded,
  SettingsRounded,
  TableChartRounded,
  ViewListRounded,
} from "@mui/icons-material"

const defaultIconMap: Record<string, ReactNode> = {
  dashboard: <DashboardRounded />,
  home: <HomeRounded />,
  people: <PeopleRounded />,
  groups: <GroupsRounded />,
  accounts: <ManageAccountsRounded />,
  documentacao: <DescriptionRounded />,
  description: <DescriptionRounded />,
  folder: <FolderRounded />,
  grid: <GridViewRounded />,
  table: <TableChartRounded />,
  list: <ListAltRounded />,
  viewlist: <ViewListRounded />,
  settings: <SettingsRounded />,
}

export function resolveIcon(name: string | undefined): ReactNode | undefined {
  if (!name) return undefined
  const key = name.trim().toLowerCase()
  return defaultIconMap[key] ?? undefined
}

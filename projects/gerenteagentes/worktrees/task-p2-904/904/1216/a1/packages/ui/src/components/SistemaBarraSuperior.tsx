import type { ReactNode } from "react"
import {
  AppBar,
  Breadcrumbs,
  Box,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material"
import { MenuRounded, MenuOpenRounded } from "@mui/icons-material"
import type { SistemaBreadcrumbItem } from "../utils/system"

export interface SistemaBarraSuperiorProps {
  appName: string
  breadcrumbs: SistemaBreadcrumbItem[]
  desktop: boolean
  drawerWidth: number
  actions?: ReactNode
  onOpenMenu: () => void
  /** Estado recolhido da navegação desktop; opcional para compatibilidade. */
  menuCollapsed?: boolean
  /** Alterna a navegação desktop; opcional para consumidores antigos. */
  onToggleMenu?: () => void
}

export default function SistemaBarraSuperior({
  appName,
  breadcrumbs,
  desktop,
  drawerWidth,
  actions,
  onOpenMenu,
  menuCollapsed = false,
  onToggleMenu = () => undefined,
}: SistemaBarraSuperiorProps) {
  const currentPage = breadcrumbs.at(-1)?.label

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        bgcolor: "background.paper",
        color: "text.primary",
        borderBottom: "1px solid",
        borderColor: "divider",
        width: desktop && !menuCollapsed ? `calc(100% - ${drawerWidth}px)` : "100%",
        ml: desktop && !menuCollapsed ? `${drawerWidth}px` : 0,
      }}
    >
      <Toolbar>
        {desktop ? (
          <Tooltip title={menuCollapsed ? "Mostrar menu" : "Ocultar menu"}>
            <IconButton
              edge="start"
              onClick={onToggleMenu}
              sx={{ mr: 1 }}
              aria-label={menuCollapsed ? "Mostrar menu" : "Ocultar menu"}
            >
              {menuCollapsed ? <MenuRounded /> : <MenuOpenRounded />}
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Abrir menu">
            <IconButton edge="start" onClick={onOpenMenu} sx={{ mr: 1 }} aria-label="Abrir menu">
              <MenuRounded />
            </IconButton>
          </Tooltip>
        )}

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Breadcrumbs aria-label="Localização atual" sx={{ display: { xs: "none", sm: "flex" } }}>
            {breadcrumbs.map((item, index) => (
              <Typography
                key={item.id}
                color={index === breadcrumbs.length - 1 ? "text.primary" : "text.secondary"}
                fontWeight={index === breadcrumbs.length - 1 ? 800 : 400}
              >
                {item.label}
              </Typography>
            ))}
          </Breadcrumbs>
          <Typography fontWeight={800} noWrap sx={{ display: { xs: "block", sm: "none" } }}>
            {currentPage ?? appName}
          </Typography>
        </Box>

        {actions}
      </Toolbar>
    </AppBar>
  )
}

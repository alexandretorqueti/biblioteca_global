import { useState, type ReactNode } from "react"
import {
  Box,
  Container,
  Drawer,
  Stack,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material"
import Cadastro from "./Cadastro"
import SistemaBarraSuperior from "./SistemaBarraSuperior"
import SistemaMenu from "./SistemaMenu"
import type { EntityRecord, GeradorSistemaConfig } from "../types"
import { findSistemaRoute, getSistemaBreadcrumb } from "../utils/system"

const defaultDrawerWidth = 280

export interface GeradorSistemaProps<T extends EntityRecord> {
  config: GeradorSistemaConfig<T>
  activePath?: string
  initialPath?: string
  actions?: ReactNode
  onRouteChange?: (path: string) => void
}

export default function GeradorSistema<T extends EntityRecord>({
  config,
  activePath,
  initialPath,
  actions,
  onRouteChange,
}: GeradorSistemaProps<T>) {
  const theme = useTheme()
  const desktop = useMediaQuery(theme.breakpoints.up("md"))
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const firstPath = config.groups[0]?.items[0]?.path ?? ""
  const [uncontrolledPath, setUncontrolledPath] = useState(initialPath ?? firstPath)
  const currentPath = activePath ?? uncontrolledPath
  const currentRoute = findSistemaRoute(config, currentPath)
  const breadcrumbs = getSistemaBreadcrumb(config, currentPath)
  const drawerWidth = config.drawerWidth ?? defaultDrawerWidth

  const navigate = (path: string) => {
    if (activePath === undefined) {
      setUncontrolledPath(path)
    }
    onRouteChange?.(path)
    setMobileMenuOpen(false)
  }

  const menuHeader = (
    <Toolbar>
      <Stack direction="row" spacing={1.5} alignItems="center" minWidth={0}>
        {config.app.logo}
        <Typography variant="h6" fontWeight={800} noWrap>
          {config.app.name}
        </Typography>
      </Stack>
    </Toolbar>
  )

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <SistemaBarraSuperior
        appName={config.app.name}
        breadcrumbs={breadcrumbs}
        desktop={desktop}
        drawerWidth={drawerWidth}
        actions={actions}
        onOpenMenu={() => setMobileMenuOpen(true)}
      />

      <Box component="nav" aria-label="Navegação principal" sx={{ width: { md: drawerWidth }, flexShrink: 0 }}>
        <Drawer
          variant={desktop ? "permanent" : "temporary"}
          open={desktop || mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box", borderRightColor: "divider" } }}
        >
          <SistemaMenu
            groups={config.groups}
            activePath={currentPath}
            header={menuHeader}
            onNavigate={navigate}
          />
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
        <Toolbar />
        <Container maxWidth="xl" sx={{ py: { xs: 3, md: 5 } }}>
          {currentRoute?.screen.kind === "cadastro" ? (
            <Cadastro
              dataSource={currentRoute.screen.dataSource}
              title={currentRoute.screen.title}
              fields={currentRoute.screen.fields}
              columnLabels={currentRoute.screen.columnLabels}
              gridColumns={currentRoute.screen.gridColumns}
              hiddenColumns={currentRoute.screen.hiddenColumns}
              columns={currentRoute.screen.columns}
              newLabel={currentRoute.screen.newLabel}
              description={currentRoute.screen.description}
            />
          ) : currentRoute?.screen.kind === "custom" ? (
            currentRoute.screen.content
          ) : (
            <Typography color="text.secondary">Nenhuma tela foi configurada para esta rota.</Typography>
          )}
        </Container>
      </Box>
    </Box>
  )
}

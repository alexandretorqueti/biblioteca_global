import { createElement, useState, type ReactNode } from "react"
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
import type {
  CadastroDataSource,
  CadastroScreenConfig,
  CustomAction,
  ExternalScreenConfig,
  GeradorSistemaConfig,
} from "@biblioteca-global/shared"
import type { EntityRecord } from "@biblioteca-global/shared"
import Cadastro from "./Cadastro"
import ExternalScreen from "./ExternalScreen"
import SistemaBarraSuperior from "./SistemaBarraSuperior"
import SistemaMenu from "./SistemaMenu"
import type {
  GeradorSistemaCadastroScreen,
  GeradorSistemaGroup,
} from "../gerador-screens"
import type { DynamicField, ExecuteAction, GeradorSistemaRuntime } from "../types"
import { getSistemaBreadcrumb } from "../utils/system"
import { getCustomScreen } from "../registry"
import { resolveIcon } from "../icons"

const defaultDrawerWidth = 280

export interface GeradorSistemaProps {
  /** Config serializável (PoC §7) — resource/componentId/ícones por string. */
  config: GeradorSistemaConfig
  /** Runtime injetado: dataSource, upload, loadOptions, ícones. */
  runtime?: Partial<GeradorSistemaRuntime>
  activePath?: string
  initialPath?: string
  actions?: ReactNode
  onRouteChange?: (path: string) => void
}

/** Tela filha montada com dataSource em runtime. */
interface MontadaChild {
  childResource: string
  label: string
  fkField: string
  dataSource: CadastroDataSource<EntityRecord>
}

/** Tela externa montada em runtime. */
interface MontadaExternalScreen {
  kind: "external"
  baseUrl: string
  method: string
  pathTemplate: string
  actions?: CustomAction[]
  dataPath?: string
  query?: Record<string, string | number | boolean>
  executeAction?: ExecuteAction
  detailPathTemplate?: string
  detailDataPath?: string
}

/** Props injetadas na tela externa via runtime. */
export interface ExternalScreenRuntime {
  /** Parâmetros para interpolar no pathTemplate. */
  params?: Record<string, string | number>
  /** Token Bearer opcional. */
  bearerToken?: string
}

function montarTelaCadastro(
  screen: CadastroScreenConfig,
  runtime: Partial<GeradorSistemaRuntime>,
): GeradorSistemaCadastroScreen {
  const getDataSource = runtime.getDataSource
  if (!getDataSource) {
    throw new Error(
      "runtime.getDataSource é obrigatório para telas cadastro " +
        "(apps/web injeta via api-client)",
    )
  }

  const fields: DynamicField[] = (screen.fields ?? []).map((field) => {
    const runtimeField: DynamicField = { ...field }

    // uploadResource → função (via api-client); loadOptions do multipleChoice.
    if (field.uploadResource && runtime.getUpload) {
      runtimeField.upload = runtime.getUpload(field.uploadResource)
    }
    if (field.multipleChoice?.resource && runtime.getLoadOptions) {
      runtimeField.multipleChoice = {
        ...field.multipleChoice,
        loadOptions: runtime.getLoadOptions(field.multipleChoice.resource),
      }
    }

    return runtimeField
  })

  // Montar dataSources filhos para master-detail.
  const childrenDataSource: MontadaChild[] = (screen.children ?? []).map(
    (child) => ({
      ...child,
      dataSource: getDataSource(child.childResource),
    }),
  )

  return {
    kind: "cadastro",
    dataSource: getDataSource(screen.resource),
    title: screen.title ?? screen.resource,
    description: screen.description,
    fields,
    hiddenColumns: screen.overrides?.hiddenColumns,
    columns: screen.overrides?.columns,
    newLabel: screen.overrides?.newLabel,
    children: childrenDataSource.length > 0 ? childrenDataSource : undefined,
    actions: screen.actions,
    executeAction: runtime.executeAction,
  }
}

function montarGroups(
  config: GeradorSistemaConfig,
  runtime: Partial<GeradorSistemaRuntime>,
): GeradorSistemaGroup[] {
  return config.groups.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((item) => {
      const icon =
        item.icon !== undefined
          ? runtime.resolveIcon?.(item.icon) ?? resolveIcon(item.icon)
          : undefined

      const screen:
        | GeradorSistemaCadastroScreen
        | { kind: "custom"; content: ReactNode }
        | MontadaExternalScreen =
        item.screen.kind === "cadastro"
          ? montarTelaCadastro(item.screen, runtime)
          : item.screen.kind === "custom"
            ? {
                kind: "custom" as const,
                content: renderCustomScreen(item.screen.componentId),
              }
            : { // external
                kind: "external" as const,
                baseUrl: (item.screen as ExternalScreenConfig).baseUrl,
                method: (item.screen as ExternalScreenConfig).method,
                pathTemplate: (item.screen as ExternalScreenConfig).pathTemplate,
                actions: (item.screen as ExternalScreenConfig).actions ?? [],
                dataPath: (item.screen as ExternalScreenConfig).dataPath,
                query: (item.screen as ExternalScreenConfig).query,
                executeAction: runtime.executeAction,
                detailPathTemplate: (item.screen as ExternalScreenConfig).detailPathTemplate,
                detailDataPath: (item.screen as ExternalScreenConfig).detailDataPath,
              }

      return { ...item, icon, screen } as any
    }),
  }))
}

function renderCustomScreen(componentId: string): ReactNode {
  const component = getCustomScreen(componentId)
  if (!component) {
    return (
      <Typography color="text.secondary">
        Tela custom "{componentId}" não registrada no registry.
      </Typography>
    )
  }
  return createElement(component)
}

export default function GeradorSistema({
  config,
  runtime = {},
  activePath,
  initialPath,
  actions,
  onRouteChange,
}: GeradorSistemaProps) {
  const theme = useTheme()
  const desktop = useMediaQuery(theme.breakpoints.up("md"))
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const firstPath = config.groups[0]?.items[0]?.path ?? ""
  const [uncontrolledPath, setUncontrolledPath] = useState(
    initialPath ?? firstPath,
  )
  const currentPath = activePath ?? uncontrolledPath
  const breadcrumbs = getSistemaBreadcrumb(config, currentPath)
  const drawerWidth = config.drawerWidth ?? defaultDrawerWidth
  const groups = montarGroups(config, runtime)

  const navigate = (path: string) => {
    if (activePath === undefined) {
      setUncontrolledPath(path)
    }
    onRouteChange?.(path)
    setMobileMenuOpen(false)
  }

  const logo = config.app.logo
    ? runtime.resolveIcon?.(config.app.logo) ?? resolveIcon(config.app.logo)
    : undefined

  const menuHeader = (
    <Toolbar>
      <Stack direction="row" spacing={1.5} alignItems="center" minWidth={0}>
        {logo}
        <Typography variant="h6" fontWeight={800} noWrap>
          {config.app.name}
        </Typography>
      </Stack>
    </Toolbar>
  )

  const currentScreen = groups
    .flatMap((group) => group.items)
    .find((item) => item.path === currentPath)?.screen

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

      <Box
        component="nav"
        aria-label="Navegação principal"
        sx={{ width: { md: drawerWidth }, flexShrink: 0 }}
      >
        <Drawer
          variant={desktop ? "permanent" : "temporary"}
          open={desktop || mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            "& .MuiDrawer-paper": {
              width: drawerWidth,
              boxSizing: "border-box",
              borderRightColor: "divider",
            },
          }}
        >
          <SistemaMenu
            groups={groups}
            activePath={currentPath}
            header={menuHeader}
            onNavigate={navigate}
          />
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
        <Toolbar />
        <Container maxWidth="xl" sx={{ py: { xs: 3, md: 5 } }}>
          {(() => {
            const screenKind = currentScreen?.kind
            if (screenKind === "cadastro" && currentScreen) {
              return (
                <Cadastro
                  dataSource={currentScreen.dataSource}
                  title={currentScreen.title}
                  fields={currentScreen.fields}
                  columnLabels={currentScreen.columnLabels}
                  gridColumns={currentScreen.gridColumns}
                  hiddenColumns={currentScreen.hiddenColumns}
                  columns={currentScreen.columns}
                  newLabel={currentScreen.newLabel}
                  description={currentScreen.description}
                  children={currentScreen.children}
                  actions={currentScreen.actions}
                  executeAction={currentScreen.executeAction}
                />
              )
            }
            if (screenKind === "custom" && currentScreen) {
              return currentScreen.content
            }
            if (screenKind === "external" && currentScreen) {
              return (
                <ExternalScreen
                  baseUrl={currentScreen.baseUrl}
                  method={currentScreen.method}
                  pathTemplate={currentScreen.pathTemplate}
                  params={(runtime as any).externalParams ?? undefined}
                  bearerToken={(runtime as any).bearerToken ?? undefined}
                  actions={currentScreen.actions}
                  dataPath={currentScreen.dataPath}
                  query={currentScreen.query}
                  executeAction={currentScreen.executeAction}
                  detailPathTemplate={currentScreen.detailPathTemplate}
                  detailDataPath={currentScreen.detailDataPath}
                  onNavigate={(runtime as any).navigate ?? undefined}
                />
              )
            }
            return (
              <Typography color="text.secondary">
                Nenhuma tela foi configurada para esta rota.
              </Typography>
            )
          })()}
        </Container>
      </Box>
    </Box>
  )
}

import { lazy, Suspense, useMemo, useState } from "react"
import {
  Box,
  CircularProgress,
  Container,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material"
import {
  DarkModeRounded,
  DynamicFormRounded,
  GridViewRounded,
  LightModeRounded,
  LoginRounded,
  MenuBookRounded,
  AccountTreeRounded,
} from "@mui/icons-material"
import {
  GeradorSistema,
  type EntityRecord,
  type GeradorSistemaConfig,
  useBibliotecaTheme,
} from "@alexandretorqueti/biblioteca-global-ui"
import DocumentationPanel from "./components/DocumentationPanel"
import { baseClienteFields } from "./examples/ClientesExample"
import { baseVendaFields } from "./examples/VendasExample"
import { baseUsuarioFields } from "./examples/UsuariosExample"
import {
  componentMenuItems,
  exampleMenuItems,
  libraryContent,
  type Library,
  type MenuItemConfig,
} from "./library/catalog"
import { clientesDataSource, usuariosDataSource, vendasDataSource } from "./services/dataSources"
import { ProjectProvider, useProject } from "./context/ProjectContext"

const GridDemoPage = lazy(() => import("./pages/GridDemoPage"))
const LayoutDemoPage = lazy(() => import("./pages/LayoutDemoPage"))
const FormDemoPage = lazy(() => import("./pages/FormDemoPage"))
const AuthDemoPage = lazy(() => import("./pages/AuthDemoPage"))
const MultipleChoiceDemoPage = lazy(
  () => import("./pages/MultipleChoiceDemoPage"),
)
const MoneyDemoPage = lazy(() => import("./pages/MoneyDemoPage"))
const PhotoDemoPage = lazy(() => import("./pages/PhotoDemoPage"))
const ClientesPage = lazy(() => import("./pages/ClientesPage"))
const VendasPage = lazy(() => import("./pages/VendasPage"))
const UsuariosPage = lazy(() => import("./pages/UsuariosPage"))
const SistemaMenuDemoPage = lazy(() => import("./pages/SistemaMenuDemoPage"))
const SistemaBarraSuperiorDemoPage = lazy(() => import("./pages/SistemaBarraSuperiorDemoPage"))
const GeradorSistemaDemoPage = lazy(() => import("./pages/GeradorSistemaDemoPage"))

const iconFor = (item: MenuItemConfig) => {
  if (item.icon === "grid") {
    return <GridViewRounded />
  }

  if (item.icon === "auth") {
    return <LoginRounded />
  }

  if (item.icon === "system") {
    return <AccountTreeRounded />
  }

  return <DynamicFormRounded />
}

const pageFor = (library: Library) => {
  switch (library) {
    case "grid":
      return <GridDemoPage />
    case "layout":
      return <LayoutDemoPage />
    case "form":
      return <FormDemoPage />
    case "auth":
      return <AuthDemoPage />
    case "multipleChoice":
      return <MultipleChoiceDemoPage />
    case "money":
      return <MoneyDemoPage />
    case "photo":
      return <PhotoDemoPage />
    case "clientes":
      return <ClientesPage />
    case "vendas":
      return <VendasPage />
    case "usuarios":
      return <UsuariosPage />
    case "sistemaMenu":
      return <SistemaMenuDemoPage />
    case "sistemaBarraSuperior":
      return <SistemaBarraSuperiorDemoPage />
    case "geradorSistema":
      return <GeradorSistemaDemoPage />
  }
}

interface DocumentationScreenProps {
  library: Library
}

function DocumentationScreen({ library }: DocumentationScreenProps) {
  const content = libraryContent[library]

  return (
    <Container disableGutters maxWidth={false}>
      <Box>
        <Typography
          variant="h3"
          component="h1"
          fontWeight={900}
          sx={{ fontSize: { xs: "2rem", md: "3rem" } }}
        >
          {content.title}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 850, fontSize: "1.05rem" }}>
          {content.subtitle}
        </Typography>
      </Box>

      <Suspense fallback={<Box sx={{ py: 8, display: "grid", placeItems: "center" }}><CircularProgress /></Box>}>
        {pageFor(library)}
      </Suspense>

      <Box sx={{ mt: 4 }}>
        <DocumentationPanel description={content.description} code={content.code} />
      </Box>
    </Container>
  )
}

function isLibrary(path: string): path is Library {
  return Object.prototype.hasOwnProperty.call(libraryContent, path)
}

function AppContent() {
  const { themeName, setThemeName } = useBibliotecaTheme()
  const [library, setLibrary] = useState<Library>("grid")
  const { selectedProject, clearProject } = useProject()

  const config = useMemo<GeradorSistemaConfig<EntityRecord>>(
    () => ({
      app: { 
        name: selectedProject 
          ? `Biblioteca Gera • ${selectedProject.nome}` 
          : "Biblioteca Gera", 
        logo: <MenuBookRounded color="primary" /> 
      },
      groups: [
        {
          id: "componentes",
          label: "Componentes",
          items: componentMenuItems.map((item) => ({
            id: item.id,
            label: item.primary,
            description: item.secondary,
            path: item.id,
            icon: iconFor(item),
            screen: { kind: "custom", content: <DocumentationScreen library={item.id} /> },
          })),
        },
        {
          id: "exemplos",
          label: "Exemplos",
          items: exampleMenuItems.map((item) => {
            if (item.id === "clientes") {
              return {
                id: item.id,
                label: item.primary,
                description: item.secondary,
                path: item.id,
                icon: iconFor(item),
                screen: {
                  kind: "cadastro" as const,
                  dataSource: clientesDataSource,
                  title: selectedProject 
                    ? `Cadastro de Clientes — ${selectedProject.nome}`
                    : "Cadastro de Clientes",
                  description: "CRUD integrado demonstrando o GeradorSistema com o componente Cadastro.",
                  fields: baseClienteFields,
                  columns: 2 as const,
                  newLabel: "Novo cliente",
                  hiddenColumns: ["createdAt", "updatedAt"],
                },
              }
            }

            if (item.id === "vendas") {
              return {
                id: item.id,
                label: item.primary,
                description: item.secondary,
                path: item.id,
                icon: iconFor(item),
                screen: {
                  kind: "cadastro" as const,
                  dataSource: vendasDataSource,
                  title: selectedProject 
                    ? `Cadastro de Vendas — ${selectedProject.nome}`
                    : "Cadastro de Vendas",
                  description: "CRUD integrado com seleção pesquisável e valores monetários.",
                  fields: baseVendaFields,
                  columns: 2 as const,
                  newLabel: "Nova venda",
                  hiddenColumns: ["idCliente", "createdAt", "updatedAt"],
                },
              }
            }

            if (item.id === "usuarios") {
              return {
                id: item.id,
                label: item.primary,
                description: item.secondary,
                path: item.id,
                icon: iconFor(item),
                screen: {
                  kind: "cadastro" as const,
                  dataSource: usuariosDataSource,
                  title: selectedProject 
                    ? `Cadastro de Usuários — ${selectedProject.nome}`
                    : "Cadastro de Usuários",
                  description: "CRUD integrado com perfil de acesso e status ativo/inativo.",
                  fields: baseUsuarioFields,
                  columns: 2 as const,
                  newLabel: "Novo usuário",
                  hiddenColumns: ["createdAt", "updatedAt"],
                },
              }
            }

            return {
              id: item.id,
              label: item.primary,
              description: item.secondary,
              path: item.id,
              icon: iconFor(item),
              screen: { kind: "custom" as const, content: <DocumentationScreen library={item.id} /> },
            }
          }),
        },
      ],
    }),
    [selectedProject],
  )

  const actions = (
    <>
      {selectedProject && (
        <Tooltip title={`Projeto atual: ${selectedProject.nome}. Clique para limpar.`}>
          <IconButton 
            color="primary" 
            aria-label="Limpar projeto selecionado"
            onClick={clearProject}
            sx={{ mr: 1 }}
          >
            <AccountTreeRounded />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title={themeName === "claro" ? "Ativar tema escuro" : "Ativar tema claro"}>
        <IconButton color="inherit" aria-label="Alternar tema" onClick={() => setThemeName(themeName === "claro" ? "escuro" : "claro")}>
          {themeName === "claro" ? <DarkModeRounded /> : <LightModeRounded />}
        </IconButton>
      </Tooltip>
    </>
  )

  return (
    <GeradorSistema
      config={config}
      activePath={library}
      onRouteChange={(path) => {
        if (isLibrary(path)) {
          setLibrary(path)
        }
      }}
      actions={actions}
    />
  )
}

export default function App() {
  return (
    <ProjectProvider>
      <AppContent />
    </ProjectProvider>
  )
}

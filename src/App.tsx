import { lazy, Suspense, useState } from "react"
import {
  AppBar,
  Box,
  CircularProgress,
  Container,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Stack,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material"
import {
  DynamicFormRounded,
  GridViewRounded,
  LoginRounded,
  MenuBookRounded,
  MenuRounded,
} from "@mui/icons-material"
import DocumentationPanel from "./components/DocumentationPanel"
import {
  componentMenuItems,
  exampleMenuItems,
  libraryContent,
  type Library,
  type MenuItemConfig,
} from "./library/catalog"

const GridDemoPage = lazy(() => import("./pages/GridDemoPage"))
const FormDemoPage = lazy(() => import("./pages/FormDemoPage"))
const AuthDemoPage = lazy(() => import("./pages/AuthDemoPage"))
const MultipleChoiceDemoPage = lazy(
  () => import("./pages/MultipleChoiceDemoPage"),
)
const MoneyDemoPage = lazy(() => import("./pages/MoneyDemoPage"))
const PhotoDemoPage = lazy(() => import("./pages/PhotoDemoPage"))
const ClientesPage = lazy(() => import("./pages/ClientesPage"))
const VendasPage = lazy(() => import("./pages/VendasPage"))

const drawerWidth = 260

const iconFor = (item: MenuItemConfig) => {
  if (item.icon === "grid") {
    return <GridViewRounded />
  }

  if (item.icon === "auth") {
    return <LoginRounded />
  }

  return <DynamicFormRounded />
}

const pageFor = (library: Library) => {
  switch (library) {
    case "grid":
      return <GridDemoPage />
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
  }
}

export default function App() {
  const theme = useTheme()
  const desktop = useMediaQuery(theme.breakpoints.up("md"))
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [library, setLibrary] = useState<Library>("grid")
  const content = libraryContent[library]

  const selectLibrary = (selected: Library) => {
    setLibrary(selected)
    setMobileMenuOpen(false)
  }

  const renderMenuItems = (items: MenuItemConfig[]) =>
    items.map((item) => (
      <ListItemButton
        key={item.id}
        selected={library === item.id}
        onClick={() => selectLibrary(item.id)}
        sx={{ borderRadius: 2, mb: 1 }}
      >
        <ListItemIcon>{iconFor(item)}</ListItemIcon>
        <ListItemText
          primary={item.primary}
          secondary={item.secondary}
        />
      </ListItemButton>
    ))

  const menu = (
    <Box sx={{ height: "100%", bgcolor: "background.paper" }}>
      <Toolbar>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <MenuBookRounded color="primary" />
          <Typography variant="h6" fontWeight={800}>
            Biblioteca Gera
          </Typography>
        </Stack>
      </Toolbar>

      <Divider />

      <List sx={{ px: 1.5, py: 2 }}>
        <ListSubheader
          disableSticky
          sx={{ bgcolor: "transparent", px: 1, fontWeight: 800 }}
        >
          Componentes
        </ListSubheader>

        {renderMenuItems(componentMenuItems)}

        <ListSubheader
          disableSticky
          sx={{
            bgcolor: "transparent",
            px: 1,
            pt: 2,
            fontWeight: 800,
          }}
        >
          Exemplos
        </ListSubheader>

        {renderMenuItems(exampleMenuItems)}
      </List>
    </Box>
  )

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          bgcolor: "rgba(255,255,255,0.88)",
          color: "text.primary",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid",
          borderColor: "divider",
          width: desktop ? `calc(100% - ${drawerWidth}px)` : "100%",
          ml: desktop ? `${drawerWidth}px` : 0,
        }}
      >
        <Toolbar>
          {!desktop && (
            <IconButton
              edge="start"
              onClick={() => setMobileMenuOpen(true)}
              sx={{ mr: 1 }}
              aria-label="Abrir menu"
            >
              <MenuRounded />
            </IconButton>
          )}

          <Box>
            <Typography fontWeight={800}>{content.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {content.subtitle}
            </Typography>
          </Box>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: drawerWidth }, flexShrink: 0 }}>
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
          {menu}
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
        <Toolbar />

        <Container maxWidth="xl" sx={{ py: { xs: 3, md: 5 } }}>
          <Stack spacing={4}>
            <Box>
              <Typography
                variant="h3"
                component="h1"
                fontWeight={900}
                sx={{ fontSize: { xs: "2rem", md: "3rem" } }}
              >
                {content.title}
              </Typography>

              <Typography
                color="text.secondary"
                sx={{ mt: 1, maxWidth: 850, fontSize: "1.05rem" }}
              >
                {content.subtitle}
              </Typography>
            </Box>

            <Suspense
              fallback={
                <Box sx={{ py: 8, display: "grid", placeItems: "center" }}>
                  <CircularProgress />
                </Box>
              }
            >
              {pageFor(library)}
            </Suspense>

            <DocumentationPanel
              description={content.description}
              code={content.code}
            />
          </Stack>
        </Container>
      </Box>
    </Box>
  )
}

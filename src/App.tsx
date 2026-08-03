import { useState } from "react"
import {
  AppBar,
  Box,
  Container,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Paper,
  Stack,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material"
import {
  CodeRounded,
  DynamicFormRounded,
  GridViewRounded,
  LoginRounded,
  MenuBookRounded,
  MenuRounded,
} from "@mui/icons-material"
import JsonGrid, { type JsonRecord } from "./components/JsonGrid"
import DynamicForm, {
  type DynamicField,
  type DynamicFormValues,
} from "./components/DynamicForm"
import AuthPanel, {
  type AuthPanelConfig,
  type AuthValues,
} from "./components/AuthPanel"
import ClientesExample from "./examples/ClientesExample"

const drawerWidth = 260

type Library = "grid" | "form" | "auth" | "clientes"

const exampleData: JsonRecord[] = [
  {
    id: 1,
    nome: "Clean Code",
    autor: "Robert C. Martin",
    categoria: "Engenharia de software",
    disponivel: true,
  },
  {
    id: 2,
    nome: "Refactoring",
    autor: "Martin Fowler",
    categoria: "Desenvolvimento",
    disponivel: false,
  },
  {
    id: 3,
    nome: "Domain-Driven Design",
    autor: "Eric Evans",
    categoria: "Arquitetura",
    disponivel: true,
  },
]

const formFields: DynamicField[] = [
  {
    name: "nome",
    label: "Nome completo",
    type: "text",
    required: true,
    placeholder: "Digite o nome",
  },
  {
    name: "email",
    label: "E-mail",
    type: "email",
    required: true,
  },
  {
    name: "idade",
    label: "Idade",
    type: "number",
    min: 0,
    max: 120,
  },
  {
    name: "perfil",
    label: "Perfil",
    type: "select",
    required: true,
    options: [
      { label: "Administrador", value: "admin" },
      { label: "Editor", value: "editor" },
      { label: "Leitor", value: "leitor" },
    ],
  },
  {
    name: "observacoes",
    label: "Observações",
    type: "textarea",
    fullWidth: true,
  },
  {
    name: "ativo",
    label: "Usuário ativo",
    type: "switch",
    defaultValue: true,
    fullWidth: true,
  },
]

const authConfig: AuthPanelConfig = {
  appName: "Biblioteca Gera",
  title: "Acesse sua conta",
  subtitle: "Entre para acessar os componentes e tutoriais",
  loginIdentifier: "cpf",
  customIdentifierLabel: "CPF",
  allowRegistration: true,
  allowPasswordRecovery: true,
  allowRememberMe: true,
  requirePasswordConfirmation: true,
  registrationColumns: 2,
  socialProviders: [
    { provider: "google", label: "Google" },
    { provider: "github", label: "GitHub" },
  ],
  registrationFields: [
    {
      name: "nome",
      label: "Nome completo",
      type: "text",
      required: true,
      fullWidth: true,
    },
    {
      name: "email",
      label: "E-mail",
      type: "email",
      required: true,
    },
    {
      name: "telefone",
      label: "Telefone",
      type: "tel",
      required: true,
    },
    {
      name: "cpf",
      label: "CPF",
      type: "text",
      required: true,
    },
    {
      name: "dataNascimento",
      label: "Data de nascimento",
      type: "date",
    },
    {
      name: "perfil",
      label: "Perfil",
      type: "select",
      required: true,
      options: [
        { label: "Administrador", value: "admin" },
        { label: "Editor", value: "editor" },
        { label: "Leitor", value: "reader" },
      ],
    },
    {
      name: "password",
      label: "Senha",
      type: "password",
      required: true,
    },
    {
      name: "termos",
      label: "Aceito os termos de uso e a política de privacidade",
      type: "checkbox",
      required: true,
      fullWidth: true,
    },
  ],
}

const gridCode = `const livros = [
  {
    id: 1,
    nome: "Clean Code",
    autor: "Robert C. Martin",
    disponivel: true,
  },
]

<JsonGrid
  title="Livros cadastrados"
  data={livros}
/>`

const formCode = `const fields: DynamicField[] = [
  {
    name: "nome",
    label: "Nome completo",
    type: "text",
    required: true,
  },
  {
    name: "perfil",
    label: "Perfil",
    type: "select",
    options: [
      { label: "Administrador", value: "admin" },
      { label: "Leitor", value: "leitor" },
    ],
  },
]

<DynamicForm
  title="Cadastro de usuário"
  fields={fields}
  columns={2}
  onSubmit={(values) => console.log(values)}
/>`

const authCode = `const authConfig: AuthPanelConfig = {
  appName: "Minha aplicação",
  loginIdentifier: "cpf",
  customIdentifierLabel: "CPF",
  allowRegistration: true,
  allowPasswordRecovery: true,
  allowRememberMe: true,
  requirePasswordConfirmation: true,
  registrationColumns: 2,
  socialProviders: [
    { provider: "google", label: "Google" },
    { provider: "github", label: "GitHub" },
  ],
  registrationFields: [
    {
      name: "nome",
      label: "Nome completo",
      type: "text",
      required: true,
      fullWidth: true,
    },
    {
      name: "email",
      label: "E-mail",
      type: "email",
      required: true,
    },
    {
      name: "passport",
      label: "Passaporte",
      type: "text",
    },
    {
      name: "password",
      label: "Senha",
      type: "password",
      required: true,
    },
  ],
}

<AuthPanel
  config={authConfig}
  onLogin={(values) => console.log("login", values)}
  onRegister={(values) => console.log("cadastro", values)}
  onForgotPassword={(identifier) => console.log(identifier)}
  onSocialLogin={(provider) => console.log(provider)}
/>`

const libraryContent = {
  grid: {
    name: "JsonGrid",
    title: "Grade de dados JSON",
    subtitle:
      "O JsonGrid recebe um array de objetos, identifica automaticamente todas as propriedades e utiliza seus nomes como títulos das colunas.",
    description:
      "Importe o componente e informe o array por meio da propriedade data.",
    code: gridCode,
  },
  form: {
    name: "DynamicForm",
    title: "Formulário dinâmico",
    subtitle:
      "O DynamicForm recebe uma lista de campos e monta automaticamente um formulário responsivo com validação nativa, selects, switches e diferentes tipos de entrada.",
    description:
      "Defina os campos em um array e passe a configuração para a propriedade fields.",
    code: formCode,
  },
  auth: {
    name: "AuthPanel",
    title: "Autenticação personalizável",
    subtitle:
      "O AuthPanel monta login, cadastro, recuperação de senha e autenticação social a partir de uma configuração JSON.",
    description:
      "Escolha o identificador de acesso, os provedores sociais, os recursos disponíveis e todos os campos do cadastro.",
    code: authCode,
  },
  clientes: {
    name: "Cadastro de Clientes",
    title: "Exemplo integrado",
    subtitle:
      "Cadastro completo usando formulário, grid, controller, API configurável, backend Node e banco SQLite.",
    description:
      "A entidade clientes é resolvida pelo arquivo de configuração e encaminhada automaticamente ao backend correto.",
    code: `const cadastro = {
  entity: "clientes",
  fields: [
    { name: "razaoSocial", label: "Razão Social", type: "text" },
    { name: "nomeFantasia", label: "Nome Fantasia", type: "text" },
    { name: "cnpj", label: "CNPJ", type: "text" },
  ],
}

<Cadastro {...cadastro} />`,
  },
}

export default function App() {
  const theme = useTheme()
  const desktop = useMediaQuery(theme.breakpoints.up("md"))
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [library, setLibrary] = useState<Library>("grid")
  const [formResult, setFormResult] = useState<DynamicFormValues | null>(null)
  const [authResult, setAuthResult] = useState<{
    action: string
    values: AuthValues | string
  } | null>(null)

  const content = libraryContent[library]

  const selectLibrary = (selected: Library) => {
    setLibrary(selected)
    setMobileMenuOpen(false)
  }

  const componentMenuItems = [
    {
      id: "grid" as const,
      icon: <GridViewRounded />,
      primary: "JsonGrid",
      secondary: "Grade para arrays JSON",
    },
    {
      id: "form" as const,
      icon: <DynamicFormRounded />,
      primary: "DynamicForm",
      secondary: "Formulários por configuração",
    },
    {
      id: "auth" as const,
      icon: <LoginRounded />,
      primary: "AuthPanel",
      secondary: "Login e cadastro configuráveis",
    },
  ]

  const exampleMenuItems = [
    {
      id: "clientes" as const,
      icon: <DynamicFormRounded />,
      primary: "Cadastro de Clientes",
      secondary: "CRUD completo integrado",
    },
  ]

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

      <List
        sx={{ px: 1.5, py: 2 }}
        subheader={
          <ListSubheader
            disableSticky
            sx={{ bgcolor: "transparent", px: 1, fontWeight: 800 }}
          >
            Componentes
          </ListSubheader>
        }
      >
        {componentMenuItems.map((item) => (
          <ListItemButton
            key={item.id}
            selected={library === item.id}
            onClick={() => selectLibrary(item.id)}
            sx={{ borderRadius: 2, mb: 1 }}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText
              primary={item.primary}
              secondary={item.secondary}
            />
          </ListItemButton>
        ))}

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

        {exampleMenuItems.map((item) => (
          <ListItemButton
            key={item.id}
            selected={library === item.id}
            onClick={() => selectLibrary(item.id)}
            sx={{ borderRadius: 2, mb: 1 }}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText
              primary={item.primary}
              secondary={item.secondary}
            />
          </ListItemButton>
        ))}
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

            {library === "grid" && (
              <JsonGrid title="Livros cadastrados" data={exampleData} />
            )}

            {library === "form" && (
              <>
                <DynamicForm
                  title="Cadastro de usuário"
                  fields={formFields}
                  columns={2}
                  submitLabel="Salvar usuário"
                  onSubmit={setFormResult}
                />

                {formResult && (
                  <Paper
                    elevation={0}
                    sx={{
                      p: 3,
                      border: "1px solid",
                      borderColor: "divider",
                    }}
                  >
                    <Typography variant="h6" fontWeight={800} mb={2}>
                      Resultado enviado
                    </Typography>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 2,
                        overflowX: "auto",
                        borderRadius: 2,
                        bgcolor: "#0f172a",
                        color: "#e2e8f0",
                      }}
                    >
                      {JSON.stringify(formResult, null, 2)}
                    </Box>
                  </Paper>
                )}
              </>
            )}

            {library === "clientes" && <ClientesExample />}

            {library === "auth" && (
              <>
                <AuthPanel
                  config={authConfig}
                  onLogin={(values) =>
                    setAuthResult({ action: "login", values })
                  }
                  onRegister={(values) =>
                    setAuthResult({ action: "cadastro", values })
                  }
                  onForgotPassword={(identifier) =>
                    setAuthResult({
                      action: "recuperação de senha",
                      values: identifier,
                    })
                  }
                  onSocialLogin={(provider) =>
                    setAuthResult({
                      action: "login social",
                      values: provider,
                    })
                  }
                />

                {authResult && (
                  <Paper
                    elevation={0}
                    sx={{
                      p: 3,
                      border: "1px solid",
                      borderColor: "divider",
                    }}
                  >
                    <Typography variant="h6" fontWeight={800} mb={2}>
                      Evento recebido: {authResult.action}
                    </Typography>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 2,
                        overflowX: "auto",
                        borderRadius: 2,
                        bgcolor: "#0f172a",
                        color: "#e2e8f0",
                      }}
                    >
                      {JSON.stringify(authResult.values, null, 2)}
                    </Box>
                  </Paper>
                )}
              </>
            )}

            <Paper
              elevation={0}
              sx={{
                p: { xs: 2, md: 3 },
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" mb={2}>
                <CodeRounded color="primary" />
                <Typography variant="h6" fontWeight={800}>
                  Como utilizar
                </Typography>
              </Stack>

              <Typography color="text.secondary" mb={2}>
                {content.description}
              </Typography>

              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 2.5,
                  overflowX: "auto",
                  borderRadius: 2,
                  bgcolor: "#0f172a",
                  color: "#e2e8f0",
                  fontFamily: "monospace",
                  fontSize: "0.875rem",
                  lineHeight: 1.7,
                }}
              >
                <code>{content.code}</code>
              </Box>
            </Paper>
          </Stack>
        </Container>
      </Box>
    </Box>
  )
}

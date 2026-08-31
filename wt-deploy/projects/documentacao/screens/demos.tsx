/**
 * Demos executáveis da documentação — réplica do comportamento da
 * biblioteca_old, adaptadas à API v2. Dados locais (sem HTTP): a UI não
 * fala com transporte; o api-client cuidaria disso fora do protótipo.
 */
import { useState } from "react"
import {
  Box,
  Button,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import {
  AddRounded,
  GroupsRounded,
  HomeRounded,
  SettingsRounded,
} from "@mui/icons-material"
import {
  AuthPanel,
  Cadastro,
  DynamicForm,
  FieldMultipleChoice,
  GeradorSistema,
  JsonGrid,
  LayoutContainer,
  LayoutItem,
  SistemaBarraSuperior,
  SistemaMenu,
  type AuthPanelConfig,
  type AuthValues,
  type CadastroDataSource,
  type DynamicField,
  type DynamicFormValues,
  type EntityRecord,
  type GeradorSistemaConfig,
  type GeradorSistemaGroup,
  type JsonRecord,
  type MultipleChoiceConfig,
  type SistemaBreadcrumbItem,
} from "@biblioteca-global/ui"

// ── Resultado JSON (mesmo padrão do ResultPanel da biblioteca_old) ─────

function ResultPanel({ value }: { value: unknown }) {
  return (
    <Paper elevation={0} sx={{ p: 3, border: "1px solid", borderColor: "divider" }}>
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
          fontFamily: "monospace",
          fontSize: "0.875rem",
          lineHeight: 1.7,
        }}
      >
        {JSON.stringify(value, null, 2)}
      </Box>
    </Paper>
  )
}

// ── Data source em memória (substitui o HTTP da biblioteca_old) ────────

function createMemoryDataSource<T extends EntityRecord>(
  seed: T[],
): CadastroDataSource<T> {
  let rows = [...seed]
  let nextId = seed.length + 1

  return {
    async list() {
      return [...rows]
    },
    async create(values) {
      const row = { id: nextId++, ...values } as unknown as T
      rows = [...rows, row]
      return row
    },
    async update(row, values) {
      const updated = { ...row, ...values } as T
      rows = rows.map((r) => (r.id === row.id ? updated : r))
      return updated
    },
    async remove(row) {
      rows = rows.filter((r) => r.id !== row.id)
    },
    getRowId(row) {
      return row.id as string | number
    },
  }
}

// ── Dados de exemplo (locais) ───────────────────────────────────────────

const livros: JsonRecord[] = [
  { id: 1, nome: "Clean Code", autor: "Robert C. Martin", categoria: "Engenharia de software", disponivel: true },
  { id: 2, nome: "Refactoring", autor: "Martin Fowler", categoria: "Desenvolvimento", disponivel: false },
  { id: 3, nome: "Domain-Driven Design", autor: "Eric Evans", categoria: "Arquitetura", disponivel: true },
]

const clientesSeed: EntityRecord[] = [
  { id: 1, razaoSocial: "Global Tecnologia Ltda", nomeFantasia: "Global", cnpj: "12.345.678/0001-90", simplesNacional: true, createdAt: "2026-08-01", updatedAt: "2026-08-01" },
  { id: 2, razaoSocial: "Acme Comércio ME", nomeFantasia: "Acme", cnpj: "98.765.432/0001-10", simplesNacional: false, createdAt: "2026-08-02", updatedAt: "2026-08-02" },
  { id: 3, razaoSocial: "Inovação Sistemas SA", nomeFantasia: "Inovação", cnpj: "11.222.333/0001-44", simplesNacional: true, createdAt: "2026-08-03", updatedAt: "2026-08-03" },
]

const vendasSeed: EntityRecord[] = [
  { id: 1, idCliente: 1, valor: 1500.5, createdAt: "2026-08-05", updatedAt: "2026-08-05" },
  { id: 2, idCliente: 2, valor: 89.9, createdAt: "2026-08-06", updatedAt: "2026-08-06" },
]

const usuariosSeed: EntityRecord[] = [
  { id: 1, nome: "Alexandre", email: "alexandre@globaltecnologia.net", perfil: "admin", ativo: true, createdAt: "2026-08-01", updatedAt: "2026-08-01" },
  { id: 2, nome: "Marina", email: "marina@globaltecnologia.net", perfil: "operador", ativo: true, createdAt: "2026-08-04", updatedAt: "2026-08-04" },
]

const projetosBase: EntityRecord[] = [
  { id: "proj-alfa", nome: "Projeto Alfa", descricao: "Módulo principal da plataforma" },
  { id: "proj-beta", nome: "Projeto Beta", descricao: "Integrações e APIs" },
  { id: "proj-gamma", nome: "Projeto Gamma", descricao: "Relatórios e dashboards" },
  { id: "proj-delta", nome: "Projeto Delta", descricao: "Ambiente de homologação" },
]

export const clientesDataSource = createMemoryDataSource(clientesSeed)
export const vendasDataSource = createMemoryDataSource(vendasSeed)
export const usuariosDataSource = createMemoryDataSource(usuariosSeed)

// ── Demos de componentes ────────────────────────────────────────────────

function LayoutDemo() {
  const Item = ({ label }: { label: string }) => (
    <Paper variant="outlined" sx={{ p: 2, minHeight: 90, display: "grid", placeItems: "center", bgcolor: "background.default" }}>
      <Typography fontWeight={800}>{label}</Typography>
    </Paper>
  )

  return (
    <Stack spacing={5}>
      <Box>
        <Typography variant="h5" fontWeight={900} sx={{ mb: 2 }}>Grade responsiva</Typography>
        <LayoutContainer mode="grid" columns={{ xs: 1, sm: 2, md: 3 }}>
          <Item label="Coluna 1" />
          <Item label="Coluna 2" />
          <Item label="Coluna 3" />
        </LayoutContainer>
      </Box>

      <Box>
        <Typography variant="h5" fontWeight={900} sx={{ mb: 2 }}>Itens ocupando várias colunas</Typography>
        <LayoutContainer mode="grid" columns={{ xs: 1, md: 3 }}>
          <LayoutItem span={{ xs: 1, md: 2 }}>
            <Item label="Ocupa duas colunas" />
          </LayoutItem>
          <LayoutItem>
            <Item label="Ocupa uma coluna" />
          </LayoutItem>
          <LayoutItem span={{ xs: 1, md: 3 }}>
            <Item label="Ocupa toda a linha" />
          </LayoutItem>
        </LayoutContainer>
      </Box>
    </Stack>
  )
}

function GridDemo() {
  return <JsonGrid title="Livros cadastrados" data={livros} searchable sortable pagination initialPageSize={5} />
}

const formFields: DynamicField[] = [
  { name: "nome", label: "Nome completo", type: "text", required: true, minLength: 3 },
  { name: "email", label: "E-mail", type: "email", required: true },
  { name: "cnpj", label: "CNPJ", type: "text", mask: "cnpj", validator: "cnpj", maxLength: 18 },
  { name: "idade", label: "Idade", type: "number", min: 0, max: 120 },
]

function FormDemo() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Cadastro de usuário"
        fields={formFields}
        columns={2}
        submitLabel="Salvar usuário"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

const authConfig: AuthPanelConfig = {
  appName: "Biblioteca Gera",
  title: "Acesse sua conta",
  subtitle: "Entre e selecione o projeto/contexto para continuar",
  loginIdentifier: "email",
  customIdentifierLabel: "E-mail corporativo",
  allowRegistration: false,
  allowPasswordRecovery: true,
  allowRememberMe: true,
  registrationFields: [],
}

const projectConfig: MultipleChoiceConfig = {
  data: projetosBase,
  idField: "id",
  displayField: "nome",
  minimumSearchLength: 0,
  noOptionsText: "Nenhum projeto encontrado",
}

function AuthDemo() {
  const [step, setStep] = useState<"auth" | "select" | "done">("auth")
  const [authValues, setAuthValues] = useState<AuthValues | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | number>("")
  const [finalResult, setFinalResult] = useState<Record<string, unknown> | null>(null)

  const handleLogin = (values: AuthValues) => {
    setAuthValues(values)
    setSelectedProjectId("")
    setStep("select")
  }

  const handleEnterProject = () => {
    if (!selectedProjectId) return
    setFinalResult({
      autenticacao: authValues,
      projetoId: selectedProjectId,
      acessoEm: new Date().toISOString(),
    })
    setStep("done")
  }

  const reiniciar = () => {
    setStep("auth")
    setAuthValues(null)
    setSelectedProjectId("")
    setFinalResult(null)
  }

  return (
    <Stack spacing={3}>
      {step === "auth" && (
        <AuthPanel
          config={authConfig}
          onLogin={handleLogin}
          onForgotPassword={(identifier) => console.log("Recuperação:", identifier)}
        />
      )}

      {step === "select" && authValues && (
        <Paper elevation={0} sx={{ p: 3, border: "1px solid", borderColor: "divider" }}>
          <Typography variant="h6" component="h2" fontWeight={700} gutterBottom>
            Bem-vindo!
          </Typography>
          <Typography color="text.secondary" mb={2}>
            Autenticação realizada. Selecione o projeto/contexto de trabalho:
          </Typography>
          <FieldMultipleChoice
            name="projetoId"
            label="Projeto / Contexto"
            value={selectedProjectId}
            config={projectConfig}
            required
            helperText="Digite para pesquisar. O componente gerencia opções e estados automaticamente."
            onChange={(_name, value) => setSelectedProjectId(value)}
          />
          <Stack direction="row" spacing={2} mt={3}>
            <Button variant="contained" disabled={!selectedProjectId} onClick={handleEnterProject}>
              Entrar no projeto selecionado
            </Button>
            <Button variant="outlined" onClick={reiniciar}>
              Cancelar
            </Button>
          </Stack>
        </Paper>
      )}

      {step === "done" && finalResult && (
        <Stack spacing={2}>
          <Typography variant="h6" color="success.main" fontWeight={700}>
            Fluxo concluído com sucesso
          </Typography>
          <ResultPanel value={finalResult} />
          <Button variant="outlined" onClick={reiniciar} sx={{ alignSelf: "flex-start" }}>
            Reiniciar demonstração
          </Button>
        </Stack>
      )}
    </Stack>
  )
}

function MultipleChoiceDemo() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)
  const fields: DynamicField[] = [
    {
      name: "idCliente",
      label: "Cliente",
      type: "multipleChoice",
      required: true,
      fullWidth: true,
      multipleChoice: {
        data: clientesSeed,
        idField: "id",
        displayField: "razaoSocial",
        minimumSearchLength: 0,
      },
    },
  ]

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de seleção de cliente"
        fields={fields}
        columns={1}
        submitLabel="Selecionar"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

function MoneyDemo() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)
  const fields: DynamicField[] = [
    {
      name: "valor",
      label: "Valor",
      type: "money",
      required: true,
      currency: "BRL",
      currencyLocale: "pt-BR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      min: 0,
    },
  ]

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de campo monetário"
        fields={fields}
        columns={1}
        submitLabel="Salvar valor"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

function JsonDemo() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)
  const fields: DynamicField[] = [
    {
      name: "config",
      label: "Configuração (JSON)",
      type: "json",
      fullWidth: true,
      helperText:
        "Passe o mouse sobre um valor e clique no lápis para editar; use + para adicionar e a lixeira para remover.",
    },
  ]

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de edição JSON em árvore"
        fields={fields}
        columns={1}
        submitLabel="Salvar configuração"
        initialValues={{
          config: JSON.stringify(
            { app: { name: "Biblioteca Global" }, grupos: [] },
            null,
            2,
          ),
        }}
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

/** Upload local (object URL) — sem HTTP neste protótipo. */
const uploadLocal = async (file: File): Promise<string> => URL.createObjectURL(file)

function PhotoDemo() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)
  const fields: DynamicField[] = [
    {
      name: "foto",
      label: "Foto do perfil",
      type: "photo",
      required: true,
      fullWidth: true,
      accept: "image/png,image/jpeg,image/webp",
      maxFileSizeMb: 5,
      upload: uploadLocal,
      helperText: "Arraste uma imagem para a área ou clique para selecionar.",
    },
  ]

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de upload de foto"
        fields={fields}
        columns={1}
        submitLabel="Salvar foto"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

const menuGroups: GeradorSistemaGroup[] = [
  {
    id: "principal",
    label: "Principal",
    items: [
      { id: "inicio", label: "Início", path: "/inicio", icon: <HomeRounded />, screen: { kind: "custom", content: null } },
      { id: "pessoas", label: "Pessoas", description: "Alunos e responsáveis", path: "/pessoas", icon: <GroupsRounded />, screen: { kind: "custom", content: null } },
    ],
  },
  {
    id: "administracao",
    label: "Administração",
    items: [
      { id: "configuracoes", label: "Configurações", path: "/configuracoes", icon: <SettingsRounded />, screen: { kind: "custom", content: null } },
    ],
  },
]

function SistemaMenuDemo() {
  const [activePath, setActivePath] = useState("/inicio")

  return (
    <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", overflow: "hidden" }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "280px 1fr" }, minHeight: 340 }}>
        <Box sx={{ borderRight: { sm: "1px solid" }, borderColor: "divider" }}>
          <SistemaMenu groups={menuGroups} activePath={activePath} onNavigate={setActivePath} />
        </Box>
        <Box sx={{ p: 3, display: "grid", placeItems: "center", textAlign: "center" }}>
          <Box>
            <Typography variant="overline" color="text.secondary">Rota ativa</Typography>
            <Typography variant="h5" fontWeight={800}>{activePath}</Typography>
          </Box>
        </Box>
      </Box>
    </Paper>
  )
}

const breadcrumbs: SistemaBreadcrumbItem[] = [
  { id: "cadastros", label: "Cadastros" },
  { id: "clientes", label: "Clientes" },
]

function SistemaBarraSuperiorDemo() {
  const [menuOpened, setMenuOpened] = useState(false)

  return (
    <Stack spacing={2}>
      <Paper elevation={0} sx={{ position: "relative", overflow: "hidden", border: "1px solid", borderColor: "divider" }}>
        <SistemaBarraSuperior
          appName="Sistema exemplo"
          breadcrumbs={breadcrumbs}
          desktop={false}
          drawerWidth={280}
          onOpenMenu={() => setMenuOpened(true)}
          actions={<Button startIcon={<AddRounded />} variant="contained">Novo</Button>}
        />
        <Box sx={{ height: 64 }} />
      </Paper>
      <Typography color="text.secondary">
        {menuOpened ? "O botão de menu foi acionado." : "Em telas pequenas, o botão abre o menu lateral."}
      </Typography>
    </Stack>
  )
}

const geradorConfig: GeradorSistemaConfig = {
  app: { name: "Sistema demonstrativo", logo: "dashboard" },
  groups: [
    {
      id: "principal",
      label: "Principal",
      items: [
        {
          id: "painel",
          label: "Painel",
          path: "/painel",
          icon: "dashboard",
          screen: { kind: "custom", componentId: "documentation" },
        },
        {
          id: "clientes",
          label: "Clientes",
          path: "/clientes",
          icon: "people",
          screen: {
            kind: "cadastro",
            resource: "clientes",
            title: "Cadastro de Clientes",
            fields: [
              { name: "razaoSocial", label: "Razão social", type: "text", required: true },
              { name: "nomeFantasia", label: "Nome fantasia", type: "text" },
              { name: "cnpj", label: "CNPJ", type: "text", mask: "cnpj" },
              { name: "simplesNacional", label: "Simples Nacional", type: "boolean", booleanStyle: "select", defaultValue: true },
            ],
          },
        },
      ],
    },
  ],
}

function GeradorSistemaDemo() {
  const [open, setOpen] = useState(false)

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        Este exemplo abre uma prévia isolada do sistema. Cada item configura a própria tela; telas CRUD usam
        `kind: "cadastro"` e um data source injetado pelo runtime.
      </Typography>
      <Button variant="contained" onClick={() => setOpen(true)} sx={{ alignSelf: "flex-start" }}>
        Abrir prévia do sistema
      </Button>
      {open && (
        <Paper elevation={4} sx={{ overflow: "hidden", height: { xs: 540, md: 620 }, position: "relative" }}>
          <Box sx={{ transform: "scale(.78)", transformOrigin: "top left", width: "128.21%", height: "128.21%" }}>
            <GeradorSistema
              config={geradorConfig}
              runtime={{
                getDataSource: (resource) =>
                  resource === "clientes" ? clientesDataSource : clientesDataSource,
              }}
              actions={<Button onClick={() => setOpen(false)}>Fechar prévia</Button>}
            />
          </Box>
        </Paper>
      )}
    </Stack>
  )
}

// ── Exemplos CRUD (dados locais) ────────────────────────────────────────

const clienteFields: DynamicField[] = [
  { name: "razaoSocial", label: "Razão social", type: "text", required: true, minLength: 3, fullWidth: true },
  { name: "nomeFantasia", label: "Nome fantasia", type: "text" },
  { name: "cnpj", label: "CNPJ", type: "text", mask: "cnpj", validator: "cnpj", maxLength: 18 },
  { name: "simplesNacional", label: "Simples Nacional", type: "boolean", booleanStyle: "select", defaultValue: true },
]

function ClientesDemo() {
  return (
    <Cadastro
      dataSource={clientesDataSource}
      title="Cadastro de Clientes"
      description="CRUD integrado demonstrando o componente Cadastro com data source em memória."
      fields={clienteFields}
      columns={2}
      newLabel="Novo cliente"
      hiddenColumns={["createdAt", "updatedAt"]}
    />
  )
}

const vendaFields: DynamicField[] = [
  {
    name: "idCliente",
    label: "Cliente",
    type: "multipleChoice",
    required: true,
    multipleChoice: {
      data: clientesSeed,
      idField: "id",
      displayField: "razaoSocial",
      minimumSearchLength: 0,
    },
  },
  {
    name: "valor",
    label: "Valor",
    type: "money",
    required: true,
    currency: "BRL",
    currencyLocale: "pt-BR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    min: 0,
  },
]

function VendasDemo() {
  return (
    <Cadastro
      dataSource={vendasDataSource}
      title="Cadastro de Vendas"
      description="CRUD integrado com seleção pesquisável de cliente e valores monetários."
      fields={vendaFields}
      columns={2}
      newLabel="Nova venda"
      hiddenColumns={["createdAt", "updatedAt"]}
    />
  )
}

const usuarioPerfilOptions = [
  { label: "Administrador", value: "admin" },
  { label: "Gerente", value: "gerente" },
  { label: "Operador", value: "operador" },
  { label: "Visualizador", value: "visualizador" },
]

const usuarioFields: DynamicField[] = [
  { name: "nome", label: "Nome", type: "text", required: true, minLength: 3 },
  { name: "email", label: "E-mail", type: "email", required: true },
  { name: "perfil", label: "Perfil", type: "select", options: usuarioPerfilOptions, defaultValue: "operador" },
  { name: "ativo", label: "Ativo", type: "boolean", booleanStyle: "select", defaultValue: true },
]

function UsuariosDemo() {
  return (
    <Cadastro
      dataSource={usuariosDataSource}
      title="Cadastro de Usuários"
      description="CRUD integrado com perfil de acesso e status ativo/inativo."
      fields={usuarioFields}
      columns={2}
      newLabel="Novo usuário"
      hiddenColumns={["createdAt", "updatedAt"]}
    />
  )
}

// ── Mapa de demos ───────────────────────────────────────────────────────

export function demoFor(library: string): React.ReactNode {
  switch (library) {
    case "layout":
      return <LayoutDemo />
    case "grid":
      return <GridDemo />
    case "form":
      return <FormDemo />
    case "json":
      return <JsonDemo />
    case "auth":
      return <AuthDemo />
    case "multipleChoice":
      return <MultipleChoiceDemo />
    case "money":
      return <MoneyDemo />
    case "photo":
      return <PhotoDemo />
    case "sistemaMenu":
      return <SistemaMenuDemo />
    case "sistemaBarraSuperior":
      return <SistemaBarraSuperiorDemo />
    case "geradorSistema":
      return <GeradorSistemaDemo />
    case "clientes":
      return <ClientesDemo />
    case "vendas":
      return <VendasDemo />
    case "usuarios":
      return <UsuariosDemo />
    default:
      return null
  }
}

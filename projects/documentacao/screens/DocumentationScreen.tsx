import { useMemo, useState, type ReactNode } from "react"
import { Alert, Box, Button, Chip, Divider, Paper, Stack, Tab, Tabs, Typography } from "@mui/material"
import {
  DynamicForm,
  JsonGrid,
  LayoutContainer,
  LayoutItem,
  SistemaBarraSuperior,
  SistemaMenu,
  type DynamicField,
  type DynamicFormValues,
  type GeradorSistemaGroup,
  type JsonRecord,
} from "@biblioteca-global/ui"

const campos: DynamicField[] = [
  { name: "nome", label: "Nome", type: "text", required: true, minLength: 3 },
  { name: "email", label: "E-mail", type: "email", required: true },
  { name: "valor", label: "Valor", type: "money", currency: "BRL", currencyLocale: "pt-BR" },
  {
    name: "categoria",
    label: "Categoria",
    type: "multipleChoice",
    multipleChoice: {
      idField: "id",
      displayField: "nome",
      data: [
        { id: 1, nome: "Formulários" },
        { id: 2, nome: "Navegação" },
      ],
    },
  },
]

const registros: JsonRecord[] = [
  { id: 1, componente: "DynamicForm", categoria: "Formulários", estável: true },
  { id: 2, componente: "JsonGrid", categoria: "Dados", estável: true },
  { id: 3, componente: "GeradorSistema", categoria: "Sistema", estável: true },
]

const menuGroups: GeradorSistemaGroup[] = [
  {
    id: "componentes",
    label: "Componentes",
    items: [
      { id: "inicio", label: "Início", path: "inicio", screen: { kind: "custom", content: null } },
      { id: "formularios", label: "Formulários", path: "formularios", screen: { kind: "custom", content: null } },
    ],
  },
]

const itens = ["Visão geral", "Layout", "Grid", "Formulários", "Menu e barra"] as const

function Bloco({ titulo, children }: { titulo: string; children: ReactNode }): ReactNode {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" fontWeight={800} gutterBottom>{titulo}</Typography>
      {children}
    </Paper>
  )
}

export default function DocumentationScreen(): ReactNode {
  const [aba, setAba] = useState(0)
  const [resultado, setResultado] = useState<DynamicFormValues | null>(null)
  const [rota, setRota] = useState("inicio")
  const resultadoJson = useMemo(() => JSON.stringify(resultado, null, 2), [resultado])

  return (
    <Stack spacing={3} data-testid="documentation-screen">
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="h3" component="h1" fontWeight={900}>Biblioteca Global UI</Typography>
          <Chip label="React 19" color="primary" /><Chip label="MUI 7" />
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Catálogo executável dos componentes públicos. Os exemplos usam somente dados locais; transporte HTTP continua no api-client.
        </Typography>
      </Box>

      <Tabs value={aba} onChange={(_, valor: number) => setAba(valor)} variant="scrollable" scrollButtons="auto" aria-label="Seções da documentação">
        {itens.map((item) => <Tab key={item} label={item} />)}
      </Tabs>

      {aba === 0 && (
        <Bloco titulo="Componentes disponíveis">
          <Alert severity="info" sx={{ mb: 2 }}>Esta documentação roda dentro do projeto isolado documentacao.</Alert>
          <LayoutContainer mode="grid" columns={{ xs: 1, sm: 2, md: 3 }}>
            {["AuthPanel", "Cadastro", "DynamicForm", "JsonGrid", "LayoutContainer", "GeradorSistema", "SistemaMenu", "SistemaBarraSuperior", "Fields", "Temas"].map((nome) => (
              <Paper key={nome} variant="outlined" sx={{ p: 2 }}><Typography fontWeight={700}>{nome}</Typography></Paper>
            ))}
          </LayoutContainer>
        </Bloco>
      )}

      {aba === 1 && (
        <Bloco titulo="Layout responsivo">
          <LayoutContainer mode="grid" columns={{ xs: 1, md: 3 }}>
            <LayoutItem span={{ xs: 1, md: 2 }}><Paper sx={{ p: 3, bgcolor: "primary.main", color: "primary.contrastText" }}>Duas colunas</Paper></LayoutItem>
            <LayoutItem><Paper variant="outlined" sx={{ p: 3 }}>Uma coluna</Paper></LayoutItem>
          </LayoutContainer>
        </Bloco>
      )}

      {aba === 2 && <Bloco titulo="JsonGrid"><JsonGrid title="Catálogo" data={registros} /></Bloco>}

      {aba === 3 && (
        <Bloco titulo="DynamicForm + Money + MultipleChoice">
          <DynamicForm fields={campos} columns={2} submitLabel="Testar formulário" onSubmit={setResultado} />
          {resultado && <><Divider sx={{ my: 2 }} /><Typography component="pre" sx={{ whiteSpace: "pre-wrap" }}>{resultadoJson}</Typography></>}
        </Bloco>
      )}

      {aba === 4 && (
        <Bloco titulo="Navegação do sistema">
          <Paper variant="outlined" sx={{ overflow: "hidden" }}>
            <SistemaBarraSuperior appName="Demonstração" breadcrumbs={[{ id: rota, label: rota }]} desktop={false} drawerWidth={280} onOpenMenu={() => setRota("menu-aberto")} actions={<Button size="small">Ação</Button>} />
            <Box sx={{ pt: 8, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "280px 1fr" }, minHeight: 300 }}>
              <SistemaMenu groups={menuGroups} activePath={rota} onNavigate={setRota} />
              <Box sx={{ p: 3 }}><Typography>Rota ativa: {rota}</Typography></Box>
            </Box>
          </Paper>
        </Bloco>
      )}
    </Stack>
  )
}

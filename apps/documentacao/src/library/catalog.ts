export type Library =
  | "grid"
  | "layout"
  | "form"
  | "auth"
  | "multipleChoice"
  | "money"
  | "photo"
  | "clientes"
  | "vendas"

export interface LibraryContent {
  name: string
  title: string
  subtitle: string
  description: string
  code: string
}

export interface MenuItemConfig {
  id: Library
  icon: "grid" | "form" | "auth"
  primary: string
  secondary: string
}

export const componentMenuItems: MenuItemConfig[] = [
  {
    id: "layout",
    icon: "grid",
    primary: "LayoutContainer",
    secondary: "Grades e colunas responsivas",
  },
  {
    id: "grid",
    icon: "grid",
    primary: "JsonGrid",
    secondary: "Grade para arrays JSON",
  },
  {
    id: "form",
    icon: "form",
    primary: "DynamicForm",
    secondary: "Formulários por configuração",
  },
  {
    id: "auth",
    icon: "auth",
    primary: "AuthPanel",
    secondary: "Login e cadastro configuráveis",
  },
  {
    id: "multipleChoice",
    icon: "form",
    primary: "FieldMultipleChoice",
    secondary: "Combo pesquisável e remoto",
  },
  {
    id: "money",
    icon: "form",
    primary: "FieldMoney",
    secondary: "Valores monetários configuráveis",
  },
  {
    id: "photo",
    icon: "form",
    primary: "FieldPhoto",
    secondary: "Upload, arraste e pré-visualização",
  },
]

export const exampleMenuItems: MenuItemConfig[] = [
  {
    id: "clientes",
    icon: "form",
    primary: "Cadastro de Clientes",
    secondary: "CRUD completo integrado",
  },
  {
    id: "vendas",
    icon: "form",
    primary: "Cadastro de Vendas",
    secondary: "Cliente pesquisável e valor",
  },
]

export const libraryContent: Record<Library, LibraryContent> = {
  layout: {
    name: "LayoutContainer",
    title: "Layouts configuráveis",
    subtitle:
      "Organização responsiva de conteúdo em grade ou colunas usando contratos simples e reutilizáveis.",
    description:
      "Defina o modo, a quantidade de colunas, os breakpoints e o espaço ocupado por cada item.",
    code: `<LayoutContainer
  mode="grid"
  columns={{ xs: 1, sm: 2, md: 3 }}
  gap={2}
>
  <LayoutItem span={{ xs: 1, md: 2 }}>
    <ConteudoPrincipal />
  </LayoutItem>

  <LayoutItem>
    <ConteudoSecundario />
  </LayoutItem>
</LayoutContainer>`,
  },
  grid: {
    name: "JsonGrid",
    title: "Grade de dados JSON",
    subtitle:
      "Grade configurável com busca, ordenação, paginação e renderização especializada por tipo de campo.",
    description:
      "Informe o array em data e configure cada coluna por nome. Busca, ordenação e paginação são habilitadas por padrão.",
    code: `const livros = [
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
  searchable
  sortable
  pagination
  initialPageSize={10}
/>`,
  },
  form: {
    name: "DynamicForm",
    title: "Formulário dinâmico",
    subtitle:
      "Formulários responsivos criados por configuração, com validação centralizada e mensagens por campo.",
    description:
      "Defina os campos em um array. O formulário aplica obrigatoriedade, limites, e-mail, CNPJ e validações numéricas.",
    code: `const fields: DynamicField[] = [
  {
    name: "nome",
    label: "Nome completo",
    type: "text",
    required: true,
    minLength: 3,
  },
  {
    name: "cnpj",
    label: "CNPJ",
    type: "text",
    mask: "cnpj",
    validator: "cnpj",
  },
]

<DynamicForm
  fields={fields}
  columns={2}
  onSubmit={(values) => console.log(values)}
/>`,
  },
  auth: {
    name: "AuthPanel",
    title: "Autenticação personalizável",
    subtitle:
      "Login, cadastro, recuperação de senha e autenticação social configurados por propriedades.",
    description:
      "Escolha identificadores, provedores sociais, recursos e campos do cadastro.",
    code: `const config: AuthPanelConfig = {
  appName: "Minha aplicação",
  loginIdentifier: "cpf",
  allowRegistration: true,
  allowPasswordRecovery: true,
  socialProviders: [
    { provider: "google", label: "Google" },
  ],
  registrationFields: [
    {
      name: "nome",
      label: "Nome completo",
      type: "text",
      required: true,
    },
  ],
}

<AuthPanel
  config={config}
  onLogin={(values) => console.log(values)}
/>`,
  },
  multipleChoice: {
    name: "FieldMultipleChoice",
    title: "Seleção pesquisável",
    subtitle:
      "Combina texto e lista de opções, com pesquisa remota ou dados locais.",
    description:
      "Configure o identificador, o campo exibido e o parâmetro usado para filtrar a API.",
    code: `const field: DynamicField = {
  name: "idCliente",
  label: "Cliente",
  type: "multipleChoice",
  required: true,
  multipleChoice: {
    loadOptions: loadClientes,
    idField: "id",
    displayField: "razaoSocial",
    debounceMs: 300,
  },
}`,
  },
  money: {
    name: "FieldMoney",
    title: "Campo monetário",
    subtitle:
      "Campo numérico com máscara, símbolo e formatação configuráveis por moeda e localidade.",
    description:
      "Use currency para a moeda e currencyLocale para o padrão regional.",
    code: `const field: DynamicField = {
  name: "valor",
  label: "Valor",
  type: "money",
  currency: "BRL",
  currencyLocale: "pt-BR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  min: 0,
}`,
  },
  photo: {
    name: "FieldPhoto",
    title: "Upload de foto",
    subtitle:
      "Seleção, arraste, pré-visualização, substituição e envio real do arquivo ao backend.",
    description:
      "O arquivo é enviado por multipart/form-data e o formulário armazena somente a URL devolvida pela API.",
    code: `const field: DynamicField = {
  name: "foto",
  label: "Foto",
  type: "photo",
  accept: "image/png,image/jpeg,image/webp",
  maxFileSizeMb: 5,
  upload: uploadPhoto,
}`,
  },
  clientes: {
    name: "Cadastro de Clientes",
    title: "Exemplo integrado",
    subtitle:
      "CRUD completo com formulário, validação, máscara de CNPJ, grid, API Node e SQLite.",
    description:
      "A dataSource é injetada explicitamente na prop `dataSource`, que controla list/create/update/remove.",
    code: `<Cadastro
  dataSource={clientesDataSource}
  title="Cadastro de Clientes"
  fields={fields}
  gridColumns={gridColumns}
/>`,
  },
  vendas: {
    name: "Cadastro de Vendas",
    title: "Vendas com seleção de cliente",
    subtitle:
      "CRUD de vendas com cliente pesquisável e valor monetário formatado no formulário e na grid.",
    description:
      "O formulário persiste idCliente e a API retorna a razão social para apresentação.",
    code: `<Cadastro<Cliente>
  dataSource={vendasDataSource}
  title="Cadastro de Vendas"
  fields={[
    {
      name: "idCliente",
      type: "multipleChoice",
      multipleChoice: {
        loadOptions: loadClientes,
        idField: "id",
        displayField: "razaoSocial",
      },
    },
    {
      name: "valor",
      type: "money",
      currency: "BRL",
    },
  ]}
/>`,
  },
}

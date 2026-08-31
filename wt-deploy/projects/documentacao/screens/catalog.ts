/**
 * Catálogo da documentação executável — réplica do comportamento da
 * biblioteca_old (menu lateral esquerdo + explicação e exemplos à direita),
 * adaptado à API v2 (configs serializáveis, sem HTTP na UI).
 *
 * Cada item tem: nome, título, subtítulo, descrição e o código de exemplo
 * exibido no DocumentationPanel. As demos executáveis vivem em demos.tsx.
 */
export type Library =
  | "layout"
  | "grid"
  | "form"
  | "json"
  | "auth"
  | "multipleChoice"
  | "money"
  | "photo"
  | "sistemaMenu"
  | "sistemaBarraSuperior"
  | "geradorSistema"
  | "clientes"
  | "vendas"
  | "usuarios"

export interface LibraryContent {
  name: string
  title: string
  subtitle: string
  description: string
  code: string
}

export interface MenuItemConfig {
  id: Library
  icon: "grid" | "form" | "auth" | "system"
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
    id: "json",
    icon: "form",
    primary: "FieldJson",
    secondary: "Editor de JSON em árvore",
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
    secondary: "Combo pesquisável com dados locais",
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
  {
    id: "sistemaMenu",
    icon: "system",
    primary: "SistemaMenu",
    secondary: "Grupos e itens de navegação",
  },
  {
    id: "sistemaBarraSuperior",
    icon: "system",
    primary: "SistemaBarraSuperior",
    secondary: "Breadcrumb e ações responsivas",
  },
  {
    id: "geradorSistema",
    icon: "system",
    primary: "GeradorSistema",
    secondary: "Layout e telas por configuração",
  },
]

export const exampleMenuItems: MenuItemConfig[] = [
  {
    id: "clientes",
    icon: "form",
    primary: "Cadastro de Clientes",
    secondary: "CRUD completo com dados locais",
  },
  {
    id: "vendas",
    icon: "form",
    primary: "Cadastro de Vendas",
    secondary: "Cliente pesquisável e valor",
  },
  {
    id: "usuarios",
    icon: "form",
    primary: "Cadastro de Usuários",
    secondary: "Perfil de acesso e status",
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
  json: {
    name: "FieldJson",
    title: "Editor de JSON em árvore",
    subtitle:
      "Edite JSON visualmente: colapsar/expandir, editar valores e chaves, adicionar e remover propriedades.",
    description:
      "O tipo de campo json usa um editor em árvore no lugar da textarea. O form continua trabalhando com a string serializada; a validação JSON.parse permanece no submit como rede de segurança.",
    code: `const fields: DynamicField[] = [
  {
    name: "config",
    label: "Configuração (JSON)",
    type: "json",
    fullWidth: true,
    helperText:
      "Passe o mouse sobre um valor e clique no lápis para editar; use + para adicionar e a lixeira para remover.",
  },
]

<DynamicForm
  fields={fields}
  columns={1}
  initialValues={{
    config: JSON.stringify(
      { app: { name: "Biblioteca Global" }, grupos: [] },
      null,
      2,
    ),
  }}
/>`,
  },
  auth: {
    name: "AuthPanel",
    title: "Autenticação + seleção de projeto/contexto",
    subtitle:
      "Fluxo completo: login seguido de seleção de projeto usando FieldMultipleChoice.",
    description:
      "AuthPanel trata autenticação. Após login bem-sucedido, FieldMultipleChoice (com dados locais) permite selecionar o contexto/projeto. O demo mostra transição entre etapas e resultado combinado.",
    code: `// 1. AuthPanel para login
<AuthPanel
  config={authConfig}
  onLogin={(values) => {
    setAuthValues(values)
    setStep("select")
  }}
/>

// 2. FieldMultipleChoice para seleção de projeto após login
const projectConfig: MultipleChoiceConfig = {
  data: projetos,
  idField: "id",
  displayField: "nome",
}

<FieldMultipleChoice
  name="projetoId"
  label="Projeto / Contexto"
  value={selectedProjectId}
  config={projectConfig}
  onChange={handleProjectChange}
/>

// 3. Resultado combinado: { autenticacao, projeto, acessoEm }`,
  },
  multipleChoice: {
    name: "FieldMultipleChoice",
    title: "Seleção pesquisável",
    subtitle:
      "Combina texto e lista de opções, com dados locais ou carregamento remoto.",
    description:
      "Configure o identificador, o campo exibido e os dados locais (ou resource para carregamento remoto via api-client).",
    code: `const field: DynamicField = {
  name: "idCliente",
  label: "Cliente",
  type: "multipleChoice",
  required: true,
  multipleChoice: {
    data: clientes,
    idField: "id",
    displayField: "razaoSocial",
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
      "Seleção, arraste, pré-visualização, substituição e envio do arquivo.",
    description:
      "O arquivo é pré-visualizado localmente e a função de upload devolve a URL armazenada. Neste protótipo o upload é local (object URL), sem HTTP.",
    code: `const field: DynamicField = {
  name: "foto",
  label: "Foto",
  type: "photo",
  accept: "image/png,image/jpeg,image/webp",
  maxFileSizeMb: 5,
  upload: uploadLocal,
}`,
  },
  sistemaMenu: {
    name: "SistemaMenu",
    title: "Menu de sistema configurável",
    subtitle:
      "Renderiza grupos que funcionam como títulos e itens navegáveis com destaque da rota ativa.",
    description:
      "Grupos não têm rota. Cada item recebe path, label, ícone opcional e a tela que será renderizada pelo GeradorSistema.",
    code: `<SistemaMenu
  groups={groups}
  activePath={activePath}
  onNavigate={setActivePath}
/>`,
  },
  sistemaBarraSuperior: {
    name: "SistemaBarraSuperior",
    title: "Barra superior responsiva",
    subtitle:
      "Exibe breadcrumb automático, ações injetadas e botão de abertura do menu em telas estreitas.",
    description:
      "A barra não conhece autenticação. Ações, como perfil, tema ou sair, são conteúdo React injetado pela aplicação.",
    code: `<SistemaBarraSuperior
  appName="Meu sistema"
  breadcrumbs={[
    { id: "cadastros", label: "Cadastros" },
    { id: "clientes", label: "Clientes" },
  ]}
  desktop={desktop}
  drawerWidth={280}
  actions={<AcoesDaSessao />}
  onOpenMenu={openMenu}
/>`,
  },
  geradorSistema: {
    name: "GeradorSistema",
    title: "Gerador de sistemas CRUD",
    subtitle:
      "Orquestra menu, barra superior e telas customizadas ou de cadastro a partir de uma configuração tipada.",
    description:
      "A configuração é serializável: telas de cadastro apontam para um resource e o runtime injeta o data source. O GeradorSistema não contém URLs, endpoints ou transporte HTTP.",
    code: `const config: GeradorSistemaConfig = {
  app: { name: "Meu sistema", logo: "dashboard" },
  groups: [{
    id: "cadastros",
    label: "Cadastros",
    items: [{
      id: "clientes",
      label: "Clientes",
      path: "/clientes",
      icon: "people",
      screen: {
        kind: "cadastro",
        resource: "clientes",
        title: "Cadastro de clientes",
        fields: clienteFields,
      },
    }],
  }],
}

<GeradorSistema
  config={config}
  runtime={{ getDataSource }}
/>`,
  },
  clientes: {
    name: "Cadastro de Clientes",
    title: "Exemplo integrado",
    subtitle:
      "CRUD completo com formulário, validação, máscara de CNPJ e grid — usando um data source em memória.",
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
      "O formulário persiste idCliente e a lista de clientes alimenta a seleção pesquisável.",
    code: `<Cadastro
  dataSource={vendasDataSource}
  title="Cadastro de Vendas"
  fields={[
    {
      name: "idCliente",
      type: "multipleChoice",
      multipleChoice: {
        data: clientes,
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
  usuarios: {
    name: "Cadastro de Usuários",
    title: "Usuários com perfil de acesso",
    subtitle:
      "CRUD de usuários com validação de e-mail, perfil de acesso por seleção e status ativo/inativo.",
    description:
      "Demonstra o padrão de cadastro com campo tipo select para perfil (admin, gerente, operador, visualizador) e boolean para status ativo.",
    code: `<Cadastro
  dataSource={usuariosDataSource}
  title="Cadastro de Usuários"
  fields={[
    {
      name: "nome",
      type: "text",
      required: true,
      minLength: 3,
    },
    {
      name: "email",
      type: "email",
      required: true,
    },
    {
      name: "perfil",
      type: "select",
      options: usuarioPerfilOptions,
      defaultValue: "operador",
    },
    {
      name: "ativo",
      type: "boolean",
      booleanStyle: "select",
      defaultValue: true,
    },
  ]}
/>`,
  },
}

# MANUAL_DESENVOLVIMENTO.md

> Especificação operacional da Biblioteca Global.
>
> Público principal: agentes de IA e desenvolvedores responsáveis por manutenção, evolução, testes e publicação.
>
> Este documento deve ser lido antes de qualquer alteração relevante no repositório.

---

## 1. Finalidade

Este manual define:

- a arquitetura do monorepo;
- os limites entre biblioteca, cliente de API e aplicações;
- os padrões para criação e manutenção de componentes;
- as regras de TypeScript, React, Material UI e acessibilidade;
- o processo de testes, build, empacotamento e publicação;
- o protocolo de trabalho para agentes de IA;
- os critérios objetivos para considerar uma tarefa concluída.

A prioridade é consistência. Um agente deve reutilizar padrões existentes antes de criar novos.

Quando o código atual divergir deste documento:

1. verifique se a divergência é intencional;
2. preserve a compatibilidade pública;
3. corrija no menor escopo possível;
4. registre uma decisão arquitetural quando a mudança for estrutural;
5. atualize este manual quando um novo padrão for oficialmente adotado.

---

## 2. Identificação do projeto

### 2.1 Repositório

```text
biblioteca_global
```

### 2.2 Pacote principal

```text
@alexandretorqueti/biblioteca-global-ui
```

### 2.3 Registro de publicação

```text
https://npm.pkg.github.com
```

### 2.4 Estratégia de versionamento

Semantic Versioning:

```text
MAJOR.MINOR.PATCH
```

Exemplo:

```text
0.1.1
```

### 2.5 Convenção de tag

```text
ui-vX.Y.Z
```

Exemplo:

```text
ui-v0.1.1
```

---

## 3. Estrutura do monorepo

Estrutura lógica esperada:

```text
biblioteca_global/
├── apps/
│   ├── backend-exemplo/
│   └── documentacao/
├── packages/
│   ├── api-client/
│   └── ui/
├── .github/
│   └── workflows/
├── compose.yaml
├── package.json
├── package-lock.json
└── MANUAL_DESENVOLVIMENTO.md
```

A estrutura real deve ser consultada antes de qualquer alteração:

```bash
find apps packages -maxdepth 5 -type f | sort
```

---

## 4. Responsabilidade de cada área

### 4.1 `packages/ui`

Biblioteca visual reutilizável.

Pode conter:

- componentes React;
- contratos de propriedades;
- tipos TypeScript públicos;
- hooks genéricos;
- validadores puros;
- máscaras e formatadores;
- componentes de formulário;
- componentes de visualização de dados;
- componentes compostos de interface;
- contratos de data source;
- adaptadores puramente locais e sem transporte.

Não pode conter:

- URLs de servidores;
- chamadas HTTP;
- `fetch`;
- Axios;
- nomes de endpoints;
- lógica de autenticação remota;
- regras específicas de uma entidade;
- nomes de tabelas;
- acesso a banco de dados;
- leitura de arquivos do backend;
- credenciais;
- dependência de aplicações em `apps`;
- dependência direta de `packages/api-client`.

### 4.2 `packages/api-client`

Camada opcional de integração com APIs.

Pode conter:

- cliente HTTP;
- funções REST;
- serialização e desserialização;
- tratamento de erros de transporte;
- criação de data sources;
- adaptadores entre API e contratos da UI;
- configuração de cabeçalhos;
- autenticação injetada;
- tipagem de respostas.

Não deve conter:

- componentes visuais;
- JSX de interface;
- layouts;
- dependência de aplicações em `apps`;
- regras específicas de apresentação.

### 4.3 `apps/documentacao`

Aplicação de demonstração e validação manual.

Responsabilidades:

- demonstrar todos os componentes públicos;
- fornecer exemplos mínimos e completos;
- demonstrar integração com data sources;
- demonstrar estados de carregamento, erro e vazio;
- exibir exemplos de código;
- validar responsividade;
- validar tema claro e escuro;
- servir como laboratório de regressão visual.

Pode conhecer:

- URLs;
- endpoints;
- serviços;
- dados de demonstração;
- configurações específicas do backend de exemplo.

### 4.4 `apps/backend-exemplo`

Backend utilizado apenas para demonstração e testes de integração.

Responsabilidades:

- fornecer endpoints simples;
- validar fluxos CRUD;
- validar upload;
- retornar erros controlados;
- oferecer dados de exemplo;
- permitir que a documentação seja executável.

Não faz parte da biblioteca publicada.

---

## 5. Direção das dependências

Direções permitidas:

```text
apps/documentacao
    ├── packages/ui
    └── packages/api-client

packages/api-client
    └── serviços HTTP externos

apps/backend-exemplo
    └── armazenamento e sistema de arquivos
```

Direções proibidas:

```text
packages/ui → packages/api-client
packages/ui → apps/documentacao
packages/ui → apps/backend-exemplo
packages/api-client → apps/*
apps/backend-exemplo → packages/ui
```

Regra central:

> A UI recebe dados e comportamentos por propriedades. Ela não busca nem persiste dados diretamente.

---

## 6. Princípios arquiteturais

### 6.1 Inversão de controle

Operações externas são injetadas.

Incorreto:

```tsx
const response = await fetch("/api/clientes")
```

Correto:

```tsx
const rows = await dataSource.list()
```

### 6.2 Componentes controlados

Campos devem preferir o contrato:

```tsx
value
onChange
```

Estado de negócio pertence ao consumidor ou ao formulário agregador.

Estado interno é permitido para:

- foco;
- expansão;
- diálogo;
- pré-visualização;
- texto transitório;
- carregamento local;
- arraste;
- progresso temporário.

### 6.3 Composição

Preferir componentes pequenos combinados por componentes compostos.

Exemplo conceitual:

```text
Cadastro
├── DynamicForm
├── JsonGrid
├── Dialog
└── Feedback
```

### 6.4 API pública estável

É obrigatório preservar:

- nomes exportados;
- props existentes;
- valores padrão;
- callbacks;
- tipos aceitos;
- comportamento documentado.

Adicionar uma prop opcional costuma ser compatível.

Remover ou renomear uma prop é breaking change.

Alterar silenciosamente a semântica também pode ser breaking change.

### 6.5 Funções puras

Máscaras, validadores, transformações e formatadores devem ser funções puras sempre que possível.

---

## 7. Convenções de TypeScript

### 7.1 Regras obrigatórias

- manter `strict`;
- não usar `any`;
- não usar `@ts-ignore`;
- não usar casts amplos sem justificativa;
- preferir `unknown` para dados não validados;
- exportar tipos necessários ao consumidor;
- usar unions para conjuntos fechados;
- usar generics quando o tipo do consumidor deve ser preservado;
- evitar duplicação de contratos;
- manter contratos públicos pequenos e estáveis.

### 7.2 `type` e `interface`

Usar `type` para:

- unions;
- aliases;
- tipos utilitários;
- composições.

Usar `interface` para:

- props;
- contratos extensíveis de objetos;
- data sources;
- adaptadores públicos.

### 7.3 Registros genéricos

```ts
export type EntityRecord = Record<string, unknown>
```

### 7.4 Exemplo de data source genérico

```ts
export interface CadastroDataSource<T extends EntityRecord> {
  list(): Promise<T[]>
  create(values: DynamicFormValues): Promise<T>
  update(row: T, values: DynamicFormValues): Promise<T>
  remove(row: T): Promise<void>
  getRowId(row: T): string | number
}
```

### 7.5 Proibições

Não fazer:

```ts
type Props = any
```

Não fazer:

```ts
const value = response as unknown as Cliente
```

sem validação e justificativa.

---

## 8. Convenções React

### 8.1 Componentes funcionais

```tsx
export function FieldText(props: FieldTextProps) {
  return <TextField />
}
```

### 8.2 Ordem interna recomendada

1. desestruturação de props;
2. valores derivados simples;
3. refs;
4. estado;
5. memos;
6. callbacks;
7. efeitos;
8. handlers locais;
9. retorno JSX.

### 8.3 Efeitos

`useEffect` deve sincronizar o componente com algo externo.

Evitar estado derivado por efeito.

Evitar:

```tsx
useEffect(() => {
  setFullName(`${firstName} ${lastName}`)
}, [firstName, lastName])
```

Preferir:

```tsx
const fullName = `${firstName} ${lastName}`
```

### 8.4 Memoização

Não usar `useMemo`, `useCallback` ou `memo` por hábito.

Usar quando:

- há cálculo relevante;
- a identidade afeta dependências;
- há listas grandes;
- um objeto recriado dispara efeitos;
- um filho memoizado depende da estabilidade;
- uma medição demonstra ganho.

### 8.5 Chaves

Usar identificador estável.

Evitar índice como chave quando a lista pode ser reordenada, filtrada ou editada.

### 8.6 Estado duplicado

Não copiar prop para estado sem necessidade.

Quando necessário, documentar a regra de sincronização.

---

## 9. Organização de componentes

Local padrão:

```text
packages/ui/src/components/
```

Campos:

```text
packages/ui/src/components/fields/
```

Tipos compartilhados:

```text
packages/ui/src/types.ts
```

Utilitários:

```text
packages/ui/src/utils/
```

Exportações públicas:

```text
packages/ui/src/index.ts
```

### 9.1 Estrutura mínima

```text
components/
└── NomeComponente.tsx
```

### 9.2 Estrutura ampliada

```text
components/
└── NomeComponente/
    ├── NomeComponente.tsx
    ├── types.ts
    ├── hooks.ts
    ├── utils.ts
    ├── __tests__/
    └── index.ts
```

Criar pasta própria quando houver:

- subcomponentes privados;
- hooks específicos;
- utilitários locais;
- testes dedicados;
- tamanho que prejudique leitura;
- mais de uma responsabilidade interna claramente separável.

Não fragmentar um componente pequeno apenas por estética.

---

## 10. Convenção de nomes

### 10.1 Componentes

```text
PascalCase
```

Exemplo:

```text
JsonGrid
DynamicForm
FieldMoney
```

### 10.2 Hooks

```text
useCamelCase
```

Exemplo:

```text
useDebouncedValue
```

### 10.3 Funções e variáveis

```text
camelCase
```

### 10.4 Tipos públicos

Preferir sufixos claros:

```text
Props
Config
DataSource
Result
Options
Handler
```

Exemplos:

```ts
FieldMoneyProps
JsonGridColumnConfig
CadastroDataSource
UploadResult
```

---

## 11. Padrão de props

Ordem recomendada:

1. identificação;
2. conteúdo;
3. valor;
4. configuração;
5. validação;
6. estado visual;
7. callbacks.

Exemplo:

```ts
export interface FieldExampleProps {
  name: string
  label: string
  value: string
  required?: boolean
  helperText?: string
  disabled?: boolean
  onChange: (name: string, value: string) => void
}
```

Callbacks devem transportar a informação necessária, sem obrigar o consumidor a lidar com eventos DOM quando isso não é útil.

Preferir:

```ts
onChange(name, value)
```

Evitar:

```ts
onChange(event)
```

quando apenas o valor importa.

---

## 12. Componentes de campo

Um campo deve:

- receber `name`;
- receber `label`;
- receber `value`;
- receber `onChange`;
- aceitar `disabled`;
- aceitar `required` quando aplicável;
- aceitar `helperText`;
- exibir erro de forma consistente;
- ser controlado;
- não acessar API;
- não persistir dados;
- não conhecer entidades.

Modelo:

```tsx
export interface FieldColorProps {
  name: string
  label: string
  value: string
  required?: boolean
  helperText?: string
  error?: boolean
  disabled?: boolean
  onChange: (name: string, value: string) => void
}

export function FieldColor({
  name,
  label,
  value,
  required = false,
  helperText,
  error = false,
  disabled = false,
  onChange,
}: FieldColorProps) {
  return (
    <TextField
      name={name}
      label={label}
      type="color"
      value={value}
      required={required}
      helperText={helperText}
      error={error}
      disabled={disabled}
      onChange={(event) => onChange(name, event.target.value)}
    />
  )
}
```

---

## 13. Integração de novo tipo no `DynamicForm`

Fluxo conceitual:

```text
DynamicField
    ↓
Field.tsx
    ↓
FieldNovoTipo.tsx
```

Passos obrigatórios:

1. localizar `DynamicFieldType`;
2. adicionar o novo literal;
3. adicionar configuração específica ao contrato;
4. criar o componente de campo;
5. integrar o campo ao dispatcher;
6. propagar `disabled`;
7. propagar `required`;
8. propagar erro e mensagem;
9. preservar contrato controlado;
10. exportar tipos públicos;
11. criar exemplo na documentação;
12. adicionar testes da lógica;
13. executar build e testes;
14. testar o pacote empacotado.

Exemplo de union:

```ts
export type DynamicFieldType =
  | "text"
  | "email"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "switch"
  | "boolean"
  | "multipleChoice"
  | "photo"
  | "money"
```

Não presuma que essa lista está atualizada. Consulte o código antes de editar.

---

## 14. Operações externas em campos

Campos que precisam executar operações externas recebem funções.

Contrato:

```ts
export type UploadHandler = (file: File) => Promise<string>
```

Uso:

```tsx
const url = await upload(file)
onChange(name, url)
```

Implementação do consumidor:

```tsx
const upload = async (file: File): Promise<string> => {
  const formData = new FormData()
  formData.append("file", file)

  const response = await fetch("/api/uploads", {
    method: "POST",
    body: formData,
  })

  if (!response.ok) {
    throw new Error("Falha no upload.")
  }

  const result: { url: string } = await response.json()
  return result.url
}
```

A chamada HTTP pertence à aplicação ou ao `api-client`, nunca à UI.

---

## 15. Seleção local e remota

Um componente de seleção deve aceitar dados locais ou carregamento injetado.

### 15.1 Dados locais

```tsx
{
  name: "clienteId",
  label: "Cliente",
  type: "multipleChoice",
  multipleChoice: {
    data: clientes,
    idField: "id",
    displayField: "razaoSocial",
  },
}
```

### 15.2 Dados remotos

```tsx
{
  name: "clienteId",
  label: "Cliente",
  type: "multipleChoice",
  multipleChoice: {
    loadOptions: async (search) => {
      return clienteService.list({ razaoSocial: search })
    },
    idField: "id",
    displayField: "razaoSocial",
    minimumSearchLength: 0,
    debounceMs: 300,
  },
}
```

O componente não deve conhecer:

- endpoint;
- query string;
- nome da entidade;
- método HTTP;
- mecanismo de autenticação.

---

## 16. `Cadastro`

`Cadastro` é um componente composto de CRUD.

Contrato conceitual:

```ts
export interface CadastroDataSource<T> {
  list(): Promise<T[]>
  create(values: DynamicFormValues): Promise<T>
  update(row: T, values: DynamicFormValues): Promise<T>
  remove(row: T): Promise<void>
  getRowId(row: T): string | number
}
```

Exemplo:

```tsx
const dataSource = {
  list: () => clienteService.list(),

  create: (values) =>
    clienteService.create(values),

  update: (cliente, values) =>
    clienteService.update(cliente.id, values),

  remove: (cliente) =>
    clienteService.remove(cliente.id),

  getRowId: (cliente) =>
    cliente.id,
}

<Cadastro
  title="Cadastro de Clientes"
  fields={fields}
  dataSource={dataSource}
/>
```

Responsabilidades do componente:

- listar registros;
- abrir e fechar formulário;
- selecionar registro;
- criar;
- editar;
- confirmar exclusão;
- exibir carregamento;
- exibir mensagens;
- recarregar após operações.

Não é responsabilidade do componente:

- montar URL;
- autenticar;
- conhecer tabela;
- conhecer chave primária por convenção externa;
- serializar regras específicas do backend.

---

## 17. `JsonGrid`

`JsonGrid` recebe dados e configuração visual.

Exemplo:

```tsx
<JsonGrid
  data={rows}
  columns={{
    valor: {
      type: "money",
      label: "Valor",
      currency: "BRL",
      currencyLocale: "pt-BR",
    },
    criadoEm: {
      type: "date",
      label: "Criado em",
      dateFormat: "DD/MM/YYYY",
    },
  }}
/>
```

Novos tipos de coluna devem:

1. estender o contrato de configuração;
2. tratar `null` e `undefined`;
3. não alterar o valor original;
4. possuir renderização previsível;
5. respeitar alinhamento e largura;
6. aceitar configuração explícita;
7. possuir exemplo;
8. possuir teste quando houver lógica de transformação.

Valores monetários devem usar `Intl.NumberFormat`.

Datas devem respeitar configuração e timezone explicitamente.

Objetos devem ter representação definida, não depender de coerção implícita.

---

## 18. `AuthPanel`

Componentes de autenticação na biblioteca devem permanecer visuais.

Podem conter:

- campos;
- alternância entre login e cadastro;
- botão para provedores;
- validação local;
- callbacks;
- estado visual de carregamento.

Não podem conter:

- endpoint;
- token;
- persistência de sessão;
- acesso a cookie;
- implementação OAuth;
- armazenamento local obrigatório;
- navegação rígida.

Exemplo de contrato:

```ts
export interface AuthPanelProps {
  loading?: boolean
  onLogin: (values: LoginValues) => Promise<void> | void
  onRegister: (values: RegisterValues) => Promise<void> | void
  onForgotPassword?: (identifier: string) => Promise<void> | void
  onGoogleLogin?: () => Promise<void> | void
}
```

---

## 19. Validação

Local esperado:

```text
packages/ui/src/utils/formValidation.ts
```

Regras:

- validação deve ser determinística;
- não deve executar chamadas externas;
- deve produzir mensagens previsíveis;
- validadores específicos devem ser identificáveis;
- funções devem tratar valores vazios;
- regras complexas devem possuir testes.

Exemplo:

```ts
const errors = validateDynamicForm(fields, values)
```

Validação assíncrona deve ser injetada e tratada em etapa separada.

---

## 20. Máscaras e formatadores

Local esperado:

```text
packages/ui/src/utils/
```

Regras:

- máscara não substitui validação;
- função deve ser pura;
- entrada deve ser defensiva;
- saída deve ser previsível;
- não alterar o valor original;
- testar valor vazio;
- testar valor parcial;
- testar valor completo.

Exemplo:

```ts
formatCnpj("24740092000104")
```

---

## 21. Material UI e tema

Preferir:

- componentes MUI;
- `sx`;
- tokens do tema;
- breakpoints;
- cores semânticas;
- espaçamentos do tema.

Evitar:

- CSS global;
- cores fixas sem necessidade;
- seletores frágeis;
- tamanhos rígidos;
- estilos que dependem da estrutura da aplicação consumidora.

Exemplo:

```tsx
<Box
  sx={{
    display: "grid",
    gap: 2,
    gridTemplateColumns: {
      xs: "1fr",
      md: "repeat(2, minmax(0, 1fr))",
    },
  }}
/>
```

Preferir:

```tsx
color="text.secondary"
```

Evitar:

```tsx
style={{ color: "#666666" }}
```

Cores fixas são aceitáveis quando fazem parte da semântica do componente.

---

## 22. Responsividade

Todo componente deve funcionar em viewport estreita.

Verificar:

- ausência de overflow não controlado;
- quebra de texto;
- empilhamento de ações;
- largura dos diálogos;
- tabelas com scroll horizontal quando necessário;
- campos ocupando largura disponível;
- botões com área de toque adequada;
- menus utilizáveis em celular.

---

## 23. Acessibilidade

Requisitos mínimos:

- label associada ao campo;
- botão com texto ou `aria-label`;
- foco visível;
- navegação por teclado;
- não depender apenas de cor;
- erro próximo ao campo;
- imagens com `alt`;
- estado desabilitado real;
- área de arraste também acionável por teclado ou clique;
- diálogos com título;
- elementos interativos semanticamente corretos.

---

## 24. Estados assíncronos

Componentes que executam operações injetadas devem tratar:

- estado inicial;
- carregamento;
- sucesso;
- erro;
- cancelamento ou desmontagem quando aplicável;
- tentativa repetida;
- resultado vazio.

Nunca deixar botão ativo durante envio duplicado quando a operação não for idempotente.

Nunca ocultar erro relevante.

---

## 25. Tratamento de erros

Modelo:

```ts
try {
  await operation()
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : "Não foi possível concluir a operação."
}
```

Não exibir ao usuário:

- stack trace;
- token;
- cabeçalho;
- caminho interno;
- consulta SQL;
- resposta sensível.

`console.log` não é tratamento de erro.

---

## 26. Testes

Framework esperado:

```text
Vitest
```

Prioridades:

1. funções puras;
2. validadores;
3. máscaras;
4. formatadores;
5. transformações;
6. contratos críticos;
7. regressões;
8. comportamento assíncrono;
9. acessibilidade básica.

Local recomendado:

```text
src/**/__tests__/
```

Comandos:

```bash
npm test
```

```bash
npm run test --workspace @alexandretorqueti/biblioteca-global-ui
```

Cada bug lógico corrigido deve receber teste quando tecnicamente viável.

---

## 27. Documentação executável

Todo componente público deve possuir exemplo em `apps/documentacao`.

O exemplo deve cobrir:

- uso mínimo;
- configuração completa;
- estado vazio;
- estado de carregamento;
- estado de erro;
- estado desabilitado;
- responsividade;
- integração com operação externa, quando aplicável.

Não usar apenas mock estático quando a funcionalidade depende de fluxo assíncrono.

---

## 28. Exportações públicas

Arquivo normativo:

```text
packages/ui/src/index.ts
```

Todo item público deve ser exportado pela raiz.

Correto:

```ts
import {
  Cadastro,
  DynamicForm,
  JsonGrid,
  type DynamicField,
} from "@alexandretorqueti/biblioteca-global-ui"
```

Incorreto:

```ts
import Cadastro from "@alexandretorqueti/biblioteca-global-ui/dist/components/Cadastro.js"
```

Ao criar um componente:

1. exportar o componente;
2. exportar as props públicas;
3. exportar tipos necessários;
4. não exportar detalhes internos;
5. verificar se o `.d.ts` final contém o contrato esperado.

---

## 29. Build

Build geral:

```bash
npm run build
```

Build da UI:

```bash
npm run build --workspace @alexandretorqueti/biblioteca-global-ui
```

Artefatos esperados:

```text
packages/ui/dist/
```

O pacote deve produzir:

- JavaScript ESM;
- arquivos `.d.ts`;
- `dist/index.js`;
- `dist/index.d.ts`;
- estrutura importável.

React, MUI, Emotion e Day.js devem permanecer externos quando definidos como peer dependencies.

---

## 30. Compatibilidade ESM

O pacote é ESM.

Subpaths devem possuir extensão quando o pacote exigir.

Correto:

```ts
import "dayjs/locale/pt-br.js"
```

Teste de importação:

```bash
node --input-type=module -e \
  "import('@alexandretorqueti/biblioteca-global-ui').then(console.log)"
```

---

## 31. Empacotamento

Inspeção:

```bash
npm pack \
  --workspace @alexandretorqueti/biblioteca-global-ui \
  --dry-run
```

Geração real:

```bash
npm pack \
  --workspace @alexandretorqueti/biblioteca-global-ui
```

O pacote deve conter apenas o necessário:

- `dist`;
- `package.json`;
- README;
- licença;
- arquivos explicitamente publicados.

Não publicar:

- documentação da aplicação;
- backend;
- testes;
- credenciais;
- uploads;
- bancos locais;
- `node_modules`;
- tarballs antigos;
- arquivos temporários.

---

## 32. Instalação em outro projeto

`.npmrc`:

```ini
registry=https://registry.npmjs.org/
@alexandretorqueti:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Instalação:

```bash
npm install @alexandretorqueti/biblioteca-global-ui
```

Peer dependencies, quando necessárias:

```bash
npm install \
  react \
  react-dom \
  @mui/material \
  @mui/icons-material \
  @mui/x-date-pickers \
  @emotion/react \
  @emotion/styled \
  dayjs
```

---

## 33. Versionamento

### PATCH

Usar para:

- correção de bug;
- correção visual compatível;
- correção de import;
- correção de tipagem;
- melhoria interna sem alteração pública.

### MINOR

Usar para:

- novo componente;
- novo campo;
- nova prop opcional;
- novo utilitário;
- nova funcionalidade compatível.

### MAJOR

Usar para:

- remoção de export;
- renomeação;
- mudança obrigatória de props;
- alteração incompatível de comportamento;
- mudança estrutural exigida dos consumidores.

Nunca publicar a mesma versão novamente.

---

## 34. Publicação

Registry:

```text
https://npm.pkg.github.com
```

Publicação manual:

```bash
npm publish \
  --workspace @alexandretorqueti/biblioteca-global-ui \
  --registry=https://npm.pkg.github.com
```

Fluxo recomendado:

```text
alteração
→ testes
→ build
→ inspeção do tarball
→ incremento de versão
→ commit
→ push
→ tag
→ workflow
→ publicação
→ teste de instalação
```

---

## 35. GitHub Actions

Workflow esperado:

```text
.github/workflows/publish-ui.yml
```

Disparo:

```text
ui-v*
```

Permissões:

```yaml
permissions:
  contents: read
  packages: write
```

Etapas:

1. checkout;
2. Node;
3. instalação;
4. tratamento de dependência opcional do Rollup quando necessário;
5. testes;
6. build;
7. publicação.

Token:

```yaml
NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 36. Segurança

Nunca incluir no repositório:

- tokens;
- senhas;
- chaves privadas;
- cookies;
- `.npmrc` com token real;
- `.env`;
- credenciais Git;
- URLs com segredo;
- dumps com dados sensíveis.

Usar variáveis:

```text
NODE_AUTH_TOKEN
GITHUB_TOKEN
```

Uploads devem validar:

- tipo;
- extensão;
- tamanho;
- nome;
- diretório;
- erro;
- resposta.

---

## 37. Desempenho e bundle

Regras:

- preservar tree shaking;
- evitar side effects globais;
- manter peer dependencies externas;
- evitar import de biblioteca inteira;
- não incluir documentação no pacote;
- não incluir backend no pacote;
- evitar renderização desnecessária;
- considerar virtualização para grandes listas;
- medir antes de otimizar;
- verificar tamanho do tarball.

---

## 38. Processo para criar um novo componente

### 38.1 Investigar

Ler:

- este manual;
- componente semelhante;
- `packages/ui/src/index.ts`;
- exemplos;
- testes.

### 38.2 Definir o contrato

Especificar:

- objetivo;
- props;
- valor controlado;
- callbacks;
- estados visuais;
- erros;
- acessibilidade;
- responsividade;
- operações externas;
- comportamento padrão.

### 38.3 Implementar

Criar no local correto.

Evitar dependência nova.

Manter o menor contrato público possível.

### 38.4 Integrar

Quando for campo:

- atualizar union;
- atualizar configuração;
- integrar ao dispatcher;
- propagar estados comuns.

### 38.5 Exportar

Atualizar o barrel público.

### 38.6 Demonstrar

Criar exemplo funcional.

### 38.7 Testar

Executar testes e build.

### 38.8 Validar pacote

Executar `npm pack --dry-run` e teste de importação.

---

## 39. Processo para alterar componente existente

Antes de editar:

1. identificar exports;
2. localizar consumidores;
3. localizar exemplos;
4. localizar testes;
5. entender a semântica atual.

Preferir:

- prop opcional nova;
- alias temporário;
- depreciação documentada;
- alteração incremental.

Evitar:

- renomear sem migração;
- mudar default silenciosamente;
- alterar tipo de callback;
- remover export;
- trocar comportamento sem versionamento.

---

## 40. Processo para corrigir bug

1. reproduzir;
2. localizar a camada responsável;
3. criar teste de regressão;
4. corrigir no menor escopo;
5. executar testes;
6. executar build;
7. testar o pacote;
8. revisar diff;
9. incrementar PATCH quando publicar.

Não mascarar o problema com cast, `try/catch` vazio ou condição genérica.

---

## 41. Anti-padrões proibidos

Não usar em `packages/ui`:

```ts
fetch(...)
axios(...)
"http://..."
"https://..."
```

Não usar:

```ts
any
@ts-ignore
console.log
```

Não fazer:

- import de `apps/*`;
- acesso a storage obrigatório;
- navegação rígida;
- regra específica de cliente;
- duplicação de máscara;
- duplicação de validação;
- dependência nova sem justificativa;
- publicação com working tree desconhecida;
- remoção de lockfile como solução padrão;
- `npm audit fix --force` automático;
- force push sem autorização.

---

## 42. Comandos de diagnóstico

Estrutura:

```bash
find packages apps -maxdepth 5 -type f | sort
```

Acoplamento indevido:

```bash
grep -RInE \
  'fetch\(|axios|http://|https://|api-client|baseUrl' \
  packages/ui/src
```

Import antigo:

```bash
grep -RIn '@global/ui' .
```

Status:

```bash
git status -sb
```

Últimos commits:

```bash
git log -5 --oneline
```

Versão do pacote:

```bash
npm view \
  @alexandretorqueti/biblioteca-global-ui \
  version \
  --registry=https://npm.pkg.github.com
```

Diff inválido:

```bash
git diff --check
```

---

## 43. Protocolo obrigatório para agentes de IA

Antes de editar:

1. ler este manual;
2. inspecionar o repositório;
3. localizar padrão semelhante;
4. identificar API pública;
5. determinar o menor conjunto de arquivos;
6. listar riscos de compatibilidade.

Durante a implementação:

1. preservar arquitetura;
2. não introduzir transporte na UI;
3. manter tipagem estrita;
4. atualizar exports;
5. criar exemplo;
6. criar teste de regressão ou lógica;
7. não publicar sem solicitação.

Antes de concluir:

1. executar testes;
2. executar build;
3. executar `git diff --check`;
4. verificar acoplamento;
5. inspecionar `git diff`;
6. informar exatamente o que mudou;
7. informar falhas sem ocultar.

Um agente nunca deve declarar conclusão sem executar as validações disponíveis.

---

## 44. Prompt padrão para novo componente

```text
Leia MANUAL_DESENVOLVIMENTO.md integralmente.

Objetivo:
Implementar o componente [NOME].

Requisitos:
[REQUISITOS]

Restrições:
- O componente pertence a packages/ui.
- Não pode conhecer API.
- Operações externas devem ser injetadas.
- TypeScript strict.
- Sem any.
- Deve ser exportado pela raiz.
- Deve possuir exemplo funcional.
- Deve ser responsivo e acessível.
- Não adicionar dependências sem necessidade.

Antes de concluir:
1. Execute npm test.
2. Execute npm run build.
3. Execute npm pack --dry-run.
4. Execute git diff --check.
5. Verifique ausência de HTTP em packages/ui.
6. Mostre git diff --stat.
```

---

## 45. Prompt padrão para correção

```text
Leia MANUAL_DESENVOLVIMENTO.md integralmente.

Objetivo:
Corrigir o problema abaixo preservando a API pública.

Problema:
[DESCRIÇÃO]

Procedimento:
1. Reproduza.
2. Localize a camada responsável.
3. Crie teste de regressão.
4. Faça a menor alteração possível.
5. Execute testes.
6. Execute build.
7. Teste o pacote.
8. Não publique sem autorização.
```

---

## 46. Prompt padrão para refatoração

```text
Leia MANUAL_DESENVOLVIMENTO.md integralmente.

Objetivo:
Refatorar [ALVO] sem alterar comportamento público.

Restrições:
- Preserve exports.
- Preserve props.
- Preserve defaults.
- Preserve callbacks.
- Não introduza dependência nova.
- Não mova integração para a UI.
- Reduza duplicação.
- Melhore testabilidade.

Validação:
- npm test
- npm run build
- npm pack --dry-run
- git diff --check
```

---

## 47. Prompt padrão para publicação

```text
Leia MANUAL_DESENVOLVIMENTO.md integralmente.

Objetivo:
Publicar nova versão da UI.

Procedimento:
1. Verifique git status.
2. Execute testes.
3. Execute build.
4. Inspecione o tarball.
5. Determine PATCH, MINOR ou MAJOR.
6. Atualize package.json e package-lock.json.
7. Crie commit.
8. Faça push.
9. Crie tag ui-vX.Y.Z.
10. Verifique o workflow.
11. Consulte o registry.
12. Instale em projeto limpo.
13. Não exponha tokens.
```

---

## 48. Decisões arquiteturais vigentes

### ADR-001: Monorepo com npm workspaces

Motivos:

- desenvolvimento integrado;
- dependências locais;
- build coordenado;
- documentação e backend no mesmo repositório;
- publicação seletiva.

### ADR-002: UI desacoplada de transporte

Motivos:

- reutilização;
- testabilidade;
- compatibilidade com qualquer backend;
- menor acoplamento;
- inversão de controle.

### ADR-003: API client separado

Motivos:

- integração opcional;
- substituição de transporte;
- responsabilidade única;
- isolamento de autenticação e serialização.

### ADR-004: Material UI

Motivos:

- tema;
- acessibilidade;
- consistência;
- responsividade;
- produtividade.

### ADR-005: Vite e ESM

Motivos:

- build rápido;
- modo library;
- ecossistema React;
- distribuição moderna.

### ADR-006: TypeScript estrito

Motivos:

- segurança da API;
- declarações públicas;
- suporte a agentes;
- redução de regressões.

### ADR-007: GitHub Packages

Motivos:

- integração com repositório;
- controle de acesso;
- publicação por workflow;
- associação entre tag e pacote.

---

## 49. Checklist de componente

```text
[ ] Local correto
[ ] Props tipadas
[ ] Sem any
[ ] Sem HTTP
[ ] Sem regra de backend
[ ] Valor controlado
[ ] Disabled
[ ] Required
[ ] Erro
[ ] Helper text
[ ] Acessibilidade
[ ] Responsividade
[ ] Exportado pela raiz
[ ] Exemplo criado
[ ] Testes adicionados
[ ] npm test passou
[ ] npm run build passou
[ ] npm pack --dry-run passou
[ ] Import ESM passou
[ ] Nenhum arquivo temporário
```

---

## 50. Checklist de publicação

```text
[ ] Working tree conhecida
[ ] Testes aprovados
[ ] Build aprovado
[ ] Versão correta
[ ] package-lock sincronizado
[ ] Tarball inspecionado
[ ] Import ESM validado
[ ] Commit criado
[ ] Push realizado
[ ] Tag criada
[ ] Workflow aprovado
[ ] Pacote visível no registry
[ ] Instalação limpa aprovada
```

---

## 51. Definição de pronto

Uma funcionalidade está concluída quando:

- segue a arquitetura;
- preserva compatibilidade;
- está tipada;
- está exportada;
- possui exemplo;
- possui tratamento de estados;
- é acessível;
- é responsiva;
- possui teste adequado;
- passa no build;
- pode ser empacotada;
- pode ser importada;
- não contém dependência indevida;
- não contém segredo;
- possui diff compreensível.

Funcionamento apenas dentro da aplicação de documentação não é suficiente.

---

## 52. Regra final

Toda implementação deve equilibrar:

```text
reutilização
+ desacoplamento
+ estabilidade
+ clareza
+ testabilidade
+ acessibilidade
+ desempenho
+ documentação executável
```

Quando houver dúvida, preserve a API existente e escolha a solução com menor acoplamento.

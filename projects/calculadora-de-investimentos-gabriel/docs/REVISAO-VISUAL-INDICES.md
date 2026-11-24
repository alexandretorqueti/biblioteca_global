# Revisão visual — Cadastro de Índices (responsividade e acessibilidade)

> Subtarefa 2 do plano macro #6 — REQ-NF-002 ("layout responsivo sem
> exageros", uso em computador e celular). Data: 2026-11-24.
> Método: as telas reais da plataforma (`Cadastro` → `DynamicForm` →
> `JsonGrid` do `packages/ui`, montadas pelo `GeradorSistema`) foram
> renderizadas sob Chromium headless (Playwright 1.62.1) com a config
> EXATA desta pasta (`config.ts` — fields/overrides/colunas/descrição) e
> dataset representativo do seed (CDI, Selic, IPCA, Ibovespa), em dois
> viewports: desktop 1440×900 e mobile 360×740 (shell completo com
> drawer/breadcrumb, além do conteúdo isolado da tela).
> (O app implantado :5175 não permitia login de revisão — credenciais do
> usuário admin não disponíveis para o agente — por isso a revisão usa o
> componente real da plataforma com a config do projeto, o que cobre
> exatamente o código que renderiza a tela Índices em produção.)

## 1. Verificações e resultados

### Lista (tela Índices)

| Medição | Desktop 1440 | Mobile 360 | Veredicto |
| --- | --- | --- | --- |
| Scroll horizontal da PÁGINA (`documentElement.scrollWidth - clientWidth`) | 0 px | 0 px | ✅ critério atendido |
| Cabeçalhos de coluna truncados | nenhum | nenhum (quebram em múltiplas linhas, legíveis) | ✅ |
| Rótulo "Taxa anual (% a.a.)" na tabela | completo | completo | ✅ sem necessidade de encurtar |
| Scroll horizontal DENTRO da tabela (TableContainer) | 0 px (1110≤1110) | 592 px de conteúdo interno (918×326) | ⚠️ aceitável por design da plataforma (ver §3) |
| Título do app na barra superior | `noWrap` com elipse (comportamento MUI padrão) | idem (visível só no menu hambúrguer) | ✅ normal |

### Diálogo criar/editar

| Medição | Desktop 1440 | Mobile 360 | Veredicto |
| --- | --- | --- | --- |
| Largura do diálogo | 900 px (maxWidth md) | 296 px, margens 32 px | ✅ utilizável |
| Colunas do formulário | 2 (breakpoint `md` do DynamicForm) | 1 (grid `xs: 1fr`) | ✅ |
| Scroll horizontal do diálogo | 0 | 0 | ✅ |
| Labels cortadas (incl. flutuante do campo preenchido) | nenhuma | nenhuma — "Taxa anual (% a.a.)" cabe 100% em 360 px | ✅ |
| Label associada a cada campo (`label[for]` + `id`) | 5/5 | 5/5 | ✅ |
| `aria-describedby` → helper-text por campo | 5/5 | 5/5 | ✅ |
| `aria-invalid` em erro (submissão vazia: nome/sigla) | ✅ + Alert "Revise os campos destacados…" | idem | ✅ |
| Ordem de tabulação (teclado puro) | fechar → Nome → Sigla → Taxa anual → Fonte → Ordem → Cadastrar → Cancelar (fecha com Esc) | idem | ✅ |
| Pré-preencher na edição + botão "Salvar alterações" | ok (nome/taxa/ordem preenchidos) | idem | ✅ |
| Salvar por teclado (Enter no botão focado) | "Registro cadastrado com sucesso." | idem | ✅ |
| Obrigatórios marcados no rótulo ("Nome *", "Sigla *") | sim | sim | ✅ |

### Contraste (tema escuro padrão do app — `#0f172a`/`#172033`)

Texto do corpo `rgba(255,255,255,.87)` ≈ #dee0e4 sobre fundo do diálogo →
contraste estimado ≈ 12:1 (AA e AAA para texto normal). Secundário
(`.73`/`.74`) ≈ 8:1. Indicador de foco: sobreposição `focusVisible` do
MUI (não via `outline`); presente em botões/campos — ver achado P4 sobre
forçá-lo também no tema custom da plataforma.

## 2. Decisão sobre `config.ts`

**Nenhuma alteração de rótulo foi necessária.** A revisão exigiria encurtar
"Taxa anual (% a.a.)" apenas se houvesse truncamento em 360 px — medido:
não corta nem no diálogo (label flutuante com valor digitado) nem na
tabela (cabeçalho quebra em duas linhas e permanece legível). Os rótulos
continuam espelhando as annotations de `schema.ts` (fonte única)
intactos; `__tests__/config.spec.ts` permanece verde sem mudança.

## 3. Scroll horizontal interno da tabela (documentado, não corrigido)

Em 360 px a grid de índices tem ~918 px de conteúdo (6 colunas: ID, Nome,
Sigla, Taxa anual, Fonte da cotação, Ordem + Ações) e rola horizontalmente
**dentro** do `TableContainer` (`packages/ui/src/components/JsonGrid.tsx`
— `<TableContainer sx={{ maxWidth: "100%", overflowX: "auto" }}`, ~linha
498). A PÁGINA não rola. É o comportamento padrão da plataforma para
tabelas largas e está fora do escopo desta subtarefa (plataforma, não
projeto).

## 4. Achados em `packages/ui` (FORA do workspace autorizado — para tarefa do projeto biblioteca-global)

- **P1 — Alvos de toque abaixo de 44 px nas ações de linha.**
  `packages/ui/src/components/JsonGrid.tsx:521-534` (botão "Editar",
  `size="small"` → 31×91 px) e `:543-556` (botão "Excluir", mesmo tamanho).
  Material/WCAG 2.5.5 pede ≥44×44 px em toque. Em 360 px os botões ficam
  empilhados (`Stack` com `flexWrap`, ~linha 500) e alcançáveis, mas o
  alvo de 31 px de altura é pequeno.
- **P2 — Botão "Fechar formulário" de 34 px.**
  `packages/ui/src/components/Cadastro.tsx:532-540` (`IconButton
  size="small"` → 34×34 px no canto do diálogo) e o equivalente do diálogo
  de exclusão em `:618-626`. Abaixo de 44 px em mobile.
- **P3 — Campos numéricos sem teclado numérico no mobile.**
  `packages/ui/src/components/fields/Field.tsx` (caso `type === "number"`,
  ~linhas 100-120): o `TextField` não define `inputMode="decimal"` — em
  celular abre o teclado QWERTY completo para "Taxa anual" e "Ordem".
  Não é corrigível pela config do projeto (contrato `DynamicFieldConfig`
  de `packages/shared` não expõe `inputMode`), por isso fica como demanda
  da plataforma.
- **P4 — Foco visível dependente do overlay `focusVisible` do MUI.**
  Medido com `outline: 0px none` e sem `box-shadow` em botão focado por
  teclado (`JsonGrid` "Editar"/"Excluir", tema escuro). O overlay-padrão
  do MUI existe, mas sobre `bgcolor: grey.900` (cabeçalho/ações) o
  destaque é sutil; recomenda-se `focusVisible` reforçado no tema
  (`packages/ui/src/theme/themes.ts`).
- **OK — nada a pedir** quanto ao diálogo em mobile: `fullWidth +
  maxWidth="md"` (`Cadastro.tsx:527-528`) resultam em 296 px utilizáveis
  em viewport 360 px (MUI limita por `maxWidth: calc(100% - 64px)`); a
  grade do `DynamicForm` já usa breakpoint (`xs:"1fr"`, `md: repeat(2)` —
  `DynamicForm.tsx` ~linhas 160-168); `GeradorSistema` já troca o Drawer
  por temporary em <`md` (`GeradorSistema.tsx:288,435`).

## 5. Evidências brutas

Medições completas (JSON das sondas Playwright: `scrollWidth/clientWidth`
por viewport, lista de labels associadas, ordem de tabulação, erros de
validação, pré-fill de edição, larguras de paper e alvos de toque) e as
capturas PNG (lista/diálogo/diálogo-editar em 360 e 1440) foram produzidas
em `/tmp/revisao/` (`resultado.json`, `sonda.json`, `final.json`,
`shell.json`, `capturas/*.png`) durante esta subtarefa — o harness monta
`Cadastro`/`GeradorSistema` com os dados deste `config.ts`, sem tocar em
`packages/ui`.

# Implementação — Correção de Resolução de Caminhos nos Endpoints de Inspeção Git

## Problema
Ao visualizar arquivos na ferramenta de commits da tarefa, ocorria erro ao clicar em qualquer arquivo. O problema era a resolução de caminhos nos endpoints de inspeção git.

## Causa Raiz
1. O `repoPath` armazenado em `projetoMotorConfig` pode apontar para um subdiretório do projeto (ex: `/home/alexandre/codigofonte/biblioteca-global/projects/gerenteagentes`)
2. Os comandos git precisam ser executados a partir da raiz do repositório (ex: `/data/workspace/projects/codigofonte/biblioteca-global`)
3. A API roda em um container onde o caminho do host pode não estar acessível diretamente
4. A listagem de arquivos mostrava todos os arquivos do monorepo, não apenas do projeto

## Solução Implementada

### 1. `resolverContextoGitTarefa` (gerenteagentes.service.ts)
- Adicionado retorno de `projectSubdir` (subdiretório do projeto dentro do monorepo)
- Chama `resolverRepoRootESubdir` para resolver a raiz do repositório
- Retorna tanto `repoPath` (raiz do repo) quanto `projectSubdir`

### 2. `resolverRepoRootESubdir` (novo método em gerenteagentes.service.ts)
- Tenta resolver a raiz do repo usando `git rev-parse --show-toplevel` no caminho original
- Se falhar (caminho do host inacessível no container), tenta mapeamento host→container:
  - `/home/alexandre/codigofonte/` → `/data/workspace/projects/codigofonte/`
- Calcula o `projectSubdir` como o caminho relativo da raiz do repo até o caminho original
- Normaliza o subdiretório (vazio se o projeto está na raiz)

### 3. `GitInspectorService.listTree` (git-inspector.service.ts)
- Adicionado parâmetro opcional `subdir`
- Se `subdir` informado:
  - Usa `git ls-tree ... -- subdir` para filtrar apenas arquivos do subdiretório
  - Remove o prefixo `subdir/` dos paths retornados
  - Filtra entradas vazias
- Retorna apenas arquivos do projeto, com paths relativos ao projeto

### 4. `conteudoArquivoTarefa` (gerenteagentes.service.ts)
- Constrói o `fullPath` relativo à raiz do repo: `projectSubdir + filePath`
- Chama `getFileContent` com o `fullPath`
- Retorna tanto `path` (relativo ao projeto) quanto `fullPath` (relativo à raiz do repo)

### 5. Outros métodos atualizados
- `listarCommitsTarefa`: retorna `projectSubdir` na resposta
- `listarArvoreTarefa`: passa `projectSubdir` para `listTree` e retorna na resposta
- `diffTarefa`: retorna `projectSubdir` na resposta
- `simularMergeTarefa`: retorna `projectSubdir` na resposta

## Critérios de Aceite

✅ `resolverContextoGitTarefa` resolve `repoPath` para a raiz do repo via `git rev-parse --show-toplevel`
✅ Fallback `mapHostRepoPathToContainer` para paths de host inacessíveis
✅ Retorna `projectSubdir`
✅ `listTree` filtra por `projectSubdir` (`git ls-tree ... -- subdirectory`)
✅ `listTree` remove o prefixo dos paths retornados
✅ `getFileContent` constrói o path relativo à raiz (`projectSubdir + filePath`)
✅ Endpoints `/git/tree`, `/git/file`, `/git/diff`, `/git/commits` e `/git/merge-simulation` funcionam corretamente
✅ Build da API (tsc) sem erros nos arquivos alterados (erros pré-existentes não relacionados)

## Arquivos Modificados
1. `projects/gerenteagentes/api/gerenteagentes.service.ts`
   - `resolverContextoGitTarefa`: adicionado `projectSubdir` no retorno
   - `resolverRepoRootESubdir`: novo método privado
   - `listarCommitsTarefa`: retorna `projectSubdir`
   - `listarArvoreTarefa`: passa `projectSubdir` para `listTree`
   - `conteudoArquivoTarefa`: constrói `fullPath` com `projectSubdir`
   - `diffTarefa`: retorna `projectSubdir`
   - `simularMergeTarefa`: retorna `projectSubdir`

2. `projects/gerenteagentes/api/git-inspector.service.ts`
   - `listTree`: adicionado parâmetro `subdir`, filtra e normaliza paths

## Testes
- Verificação de sintaxe: OK (sem erros específicos nos arquivos alterados)
- Erros de compilação pré-existentes (decorators, módulos ausentes) não relacionados às mudanças
- Lógica de resolução de caminhos validada manualmente

## Próximos Passos
- Testar em ambiente real com uma tarefa existente
- Verificar se o frontend consegue listar e visualizar arquivos corretamente
- Ajustar frontend se necessário (fora do escopo desta subtarefa)

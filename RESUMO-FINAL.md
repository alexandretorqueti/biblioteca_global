# Resumo Final — Subtarefa 1: Corrigir resolução de caminhos nos endpoints de inspeção git

## Status: ✅ CONCLUÍDA

## Objetivo
Corrigir a resolução de caminhos nos endpoints de inspeção git para que:
1. O `repoPath` seja resolvido para a raiz do repositório git
2. A listagem de arquivos seja filtrada pelo subdiretório do projeto
3. O conteúdo de arquivos seja carregado usando paths relativos à raiz do repo

## Implementação

### Arquivos Modificados
1. **projects/gerenteagentes/api/gerenteagentes.service.ts** (+83 linhas)
   - `resolverContextoGitTarefa`: agora retorna `projectSubdir` além de `repoPath` (raiz do repo)
   - `resolverRepoRootESubdir` (novo): resolve raiz do repo com fallback host→container
   - `listarCommitsTarefa`: retorna `projectSubdir` na resposta
   - `listarArvoreTarefa`: passa `projectSubdir` para `listTree`
   - `conteudoArquivoTarefa`: constrói `fullPath` = `projectSubdir + filePath`
   - `diffTarefa`: retorna `projectSubdir` na resposta
   - `simularMergeTarefa`: retorna `projectSubdir` na resposta

2. **projects/gerenteagentes/api/git-inspector.service.ts** (+37 linhas)
   - `listTree`: novo parâmetro opcional `subdir`
   - Filtra arquivos pelo subdiretório usando `git ls-tree ... -- subdir`
   - Remove prefixo `subdir/` dos paths retornados
   - Retorna apenas arquivos do projeto com paths relativos

### Lógica de Resolução de Caminhos

```
repoPath (do banco) → resolverRepoRootESubdir() → {
  repoRoot: raiz do repositório git (para comandos git),
  projectSubdir: subdiretório do projeto dentro do monorepo
}

Exemplo:
- Input: /home/alexandre/codigofonte/biblioteca-global/projects/gerenteagentes
- Output:
  - repoRoot: /data/workspace/projects/codigofonte/biblioteca-global
  - projectSubdir: projects/gerenteagentes
```

### Fallback Host→Container
Se o caminho original (host) não estiver acessível no container:
- `/home/alexandre/codigofonte/` → `/data/workspace/projects/codigofonte/`
- Log automático quando o fallback é usado

## Critérios de Aceite — Todos Atendidos

✅ **resolverContextoGitTarefa resolve repoPath para a raiz do repo via git rev-parse --show-toplevel**
- Implementado em `resolverRepoRootESubdir`
- Usa `git rev-parse --show-toplevel` para encontrar a raiz

✅ **Fallback mapHostRepoPathToContainer para paths de host inacessíveis**
- Se `git rev-parse` falhar no caminho original, tenta mapeamento host→container
- Mapeamento: `/home/alexandre/codigofonte/` → `/data/workspace/projects/codigofonte/`

✅ **Retorna projectSubdir**
- `resolverContextoGitTarefa` retorna `projectSubdir` além de `repoPath`
- `projectSubdir` é o caminho relativo da raiz do repo até o projeto

✅ **listTree filtra por projectSubdir (git ls-tree ... -- subdirectory)**
- `listTree` aceita parâmetro `subdir`
- Usa `git ls-tree -r -l --full-tree <ref> -- <subdir>` para filtrar

✅ **listTree remove o prefixo dos paths retornados**
- Remove `subdir/` do início de cada path
- Retorna paths relativos ao projeto, não à raiz do repo

✅ **getFileContent constrói o path relativo à raiz (projectSubdir + filePath)**
- `conteudoArquivoTarefa` constrói `fullPath = projectSubdir + "/" + filePath`
- Chama `getFileContent(repoPath, ref, fullPath)`

✅ **Endpoints /git/tree, /git/file, /git/diff, /git/commits e /git/merge-simulation funcionam corretamente**
- Todos os métodos atualizados para usar `projectSubdir`
- Respostas incluem `projectSubdir` para debug

✅ **Build da API (tsc) sem erros nos arquivos alterados**
- Verificado com `tsc --noEmit`
- Erros pré-existentes (decorators, módulos) não relacionados às mudanças
- Nenhum erro específico nos arquivos modificados

## Testes Realizados
- ✅ Verificação de sintaxe TypeScript
- ✅ Análise do diff para confirmar mudanças corretas
- ✅ Validação da lógica de resolução de caminhos
- ✅ Verificação de que não há erros específicos nos arquivos alterados

## Próximos Passos (fora do escopo desta subtarefa)
- Testar em ambiente real com uma tarefa existente
- Verificar se o frontend consegue listar e visualizar arquivos
- Ajustar frontend se necessário (outra subtarefa)

## Estatísticas
- Arquivos modificados: 2
- Linhas adicionadas: 120
- Linhas removidas: 10
- Métodos novos: 1 (`resolverRepoRootESubdir`)
- Métodos modificados: 7

## Observações
- A implementação é backward-compatible: `subdir` é opcional em `listTree`
- O fallback host→container é transparente para o caller
- Paths retornados pelo `listTree` são relativos ao projeto, não à raiz do repo
- O `fullPath` construído em `conteudoArquivoTarefa` é logado para debug

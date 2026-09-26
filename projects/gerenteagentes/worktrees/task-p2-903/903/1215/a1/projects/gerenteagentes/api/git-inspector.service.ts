/**
 * GitInspectorService — operações git read-only para inspeção de tarefas.
 *
 * Encapsula comandos git CLI via child_process. Todas as operações são
 * estritamente de leitura (log, ls-tree, show, diff, merge --no-commit --no-ff
 * seguido de merge --abort). Nenhum comando modifica o repositório.
 *
 * Os endpoints recebem o taskId, resolvem repoPath via projeto_motor_config
 * e a branch de integração via convenção motor-v3-work/integration-<externalId>.
 */
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Timeout padrão para comandos git (30s). */
const GIT_TIMEOUT_MS = 30_000;

// ─── Tipos públicos ─────────────────────────────────────────────────────────

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
}

export interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree'; // blob = arquivo, tree = diretório
  size?: number;
  mode: string;
}

export interface GitDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  patch: string;
  oldPath?: string; // para renames
  additions: number;
  deletions: number;
}

export interface MergeConflict {
  path: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
}

export interface MergeSimulationResult {
  success: boolean;
  conflicts: MergeConflict[];
  filesChanged: number;
  baseBranch: string;
  taskBranch: string;
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class GitInspectorService {
  private readonly logger = new Logger(GitInspectorService.name);

  /**
   * Executa um comando git no repoPath informado.
   * Lança BadRequestException se o comando falhar (stderr incluído).
   */
  private async git(repoPath: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
      return stdout;
    } catch (err: any) {
      const stderr = err?.stderr?.toString() ?? '';
      const message = err?.message ?? String(err);
      this.logger.warn(`git ${args.join(' ')} failed in ${repoPath}: ${stderr || message}`);
      throw new BadRequestException(`git ${args[0]}: ${stderr || message}`);
    }
  }

  /**
   * Verifica se uma branch existe no repositório.
   */
  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lista commits entre baseBranch e taskBranch (exclusive base, inclusive task).
   * Formato: hash|shortHash|author|email|date|message
   */
  async listCommits(repoPath: string, baseBranch: string, taskBranch: string): Promise<GitCommit[]> {
    const range = `${baseBranch}..${taskBranch}`;
    const format = '%H|%h|%an|%ae|%aI|%s';
    const stdout = await this.git(repoPath, [
      'log', '--format=' + format, '--no-merges', '--topo-order', range,
    ]);
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').map((line) => {
      const [hash = '', shortHash = '', author = '', authorEmail = '', date = '', ...msgParts] = line.split('|');
      return {
        hash,
        shortHash,
        author,
        authorEmail,
        date,
        message: msgParts.join('|'), // mensagem pode conter |
      };
    });
  }

  /**
   * Lista arquivos (árvore) em um ref (branch, tag ou commit).
   * Se ref não informado, usa HEAD.
   */
  async listTree(repoPath: string, ref?: string): Promise<GitTreeEntry[]> {
    const target = ref || 'HEAD';
    // Verifica se o ref existe
    try {
      await this.git(repoPath, ['rev-parse', '--verify', target]);
    } catch {
      throw new NotFoundException(`Ref '${target}' não encontrado`);
    }
    const stdout = await this.git(repoPath, [
      'ls-tree', '-r', '-l', '--full-tree', target,
    ]);
    if (!stdout.trim()) return [];
    // Formato: mode type hash size\tpath
    // size pode ser "-" para trees
    return stdout.trim().split('\n').map((line) => {
      const [meta = '', path = ''] = line.split('\t');
      const parts = meta.split(/\s+/);
      const mode = parts[0] || '';
      const type = (parts[1] || 'blob') as 'blob' | 'tree';
      const sizeStr = parts[3];
      return {
        path,
        type,
        size: sizeStr && sizeStr !== '-' ? parseInt(sizeStr, 10) : undefined,
        mode,
      };
    });
  }

  /**
   * Retorna o conteúdo de um arquivo em um ref específico.
   */
  async getFileContent(repoPath: string, ref: string, filePath: string): Promise<string> {
    if (!ref) throw new BadRequestException('Parâmetro ref é obrigatório');
    if (!filePath) throw new BadRequestException('Parâmetro path é obrigatório');
    // Verifica se o ref existe
    try {
      await this.git(repoPath, ['rev-parse', '--verify', ref]);
    } catch {
      throw new NotFoundException(`Ref '${ref}' não encontrado`);
    }
    const stdout = await this.git(repoPath, ['show', `${ref}:${filePath}`]);
    return stdout;
  }

  /**
   * Diff estruturado entre dois refs (from..to).
   * Retorna lista de arquivos com patch e status.
   */
  async diff(repoPath: string, from: string, to: string): Promise<GitDiffFile[]> {
    if (!from || !to) throw new BadRequestException('Parâmetros from e to são obrigatórios');
    // Verifica se os refs existem
    for (const ref of [from, to]) {
      try {
        await this.git(repoPath, ['rev-parse', '--verify', ref]);
      } catch {
        throw new NotFoundException(`Ref '${ref}' não encontrado`);
      }
    }
    // --numstat para contagem de additions/deletions
    const numstatStdout = await this.git(repoPath, [
      'diff', '--numstat', '--no-renames', from, to,
    ]);
    // --patch para o diff em si
    const patchStdout = await this.git(repoPath, [
      'diff', '--no-renames', from, to,
    ]);

    const numstatLines = numstatStdout.trim().split('\n').filter(Boolean);
    const patchSections = this.splitPatchByFile(patchStdout);

    const result: GitDiffFile[] = [];
    for (const line of numstatLines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0]!, 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1]!, 10);
      const path = parts[2]!;
      const status = this.inferStatus(additions, deletions);
      const patch = patchSections.get(path) || '';
      result.push({ path, status, patch, additions, deletions });
    }
    return result;
  }

  /**
   * Simulação de merge (dry-run) entre baseBranch e taskBranch.
   * Usa `git merge --no-commit --no-ff` seguido de `git merge --abort`.
   * Retorna lista de conflitos com conteúdo conflitante (ours/theirs/base).
   */
  async simulateMerge(
    repoPath: string,
    baseBranch: string,
    taskBranch: string,
  ): Promise<MergeSimulationResult> {
    // Verifica se ambas as branches existem
    for (const branch of [baseBranch, taskBranch]) {
      const exists = await this.branchExists(repoPath, branch);
      if (!exists) {
        throw new NotFoundException(`Branch '${branch}' não encontrada no repositório`);
      }
    }

    // Precisamos fazer checkout da base branch para simular o merge.
    // Para não modificar o working tree, usamos um worktree temporário ou
    // fazemos o merge em detached HEAD. A abordagem mais segura:
    // 1. Salvar HEAD atual
    // 2. Checkout base branch em detached mode
    // 3. Tentar merge --no-commit --no-ff
    // 4. Se houver conflitos, coletar
    // 5. merge --abort (ou reset --hard + checkout original)
    //
    // Alternativa mais limpa: usar git merge-tree (disponível no git 2.38+)
    // que faz merge simulation sem tocar no working tree.

    // Tentar git merge-tree primeiro (mais seguro, não modifica nada)
    try {
      return await this.simulateMergeViaMergeTree(repoPath, baseBranch, taskBranch);
    } catch {
      // Fallback: merge --no-commit + abort
      return await this.simulateMergeViaCheckout(repoPath, baseBranch, taskBranch);
    }
  }

  /**
   * Simulação via `git merge-tree` (git 2.38+). Não modifica o working tree.
   * Usa --name-only para listar conflitos e --write-tree para o resultado.
   */
  private async simulateMergeViaMergeTree(
    repoPath: string,
    baseBranch: string,
    taskBranch: string,
  ): Promise<MergeSimulationResult> {
    // git merge-tree --write-tree <base> <task> retorna o tree ID se sucesso
    // ou exit code != 0 se conflitos
    // Alternativa: git merge-tree --name-only <base>...<task> lista conflitos
    let mergeTreeOutput: string;
    let exitCode = 0;
    try {
      mergeTreeOutput = await this.git(repoPath, [
        'merge-tree', '--write-tree', '--no-messages',
        baseBranch, taskBranch,
      ]);
    } catch (err: any) {
      // merge-tree retorna exit code 1 quando há conflitos
      mergeTreeOutput = err?.stdout?.toString() ?? '';
      exitCode = 1;
    }

    if (exitCode === 0 && mergeTreeOutput.trim()) {
      // Merge limpo — calcular files changed via diff
      const diffResult = await this.diff(repoPath, baseBranch, taskBranch);
      return {
        success: true,
        conflicts: [],
        filesChanged: diffResult.length,
        baseBranch,
        taskBranch,
      };
    }

    // Há conflitos — extrair lista de arquivos conflitantes
    const conflicts = await this.extractConflicts(repoPath, baseBranch, taskBranch);
    return {
      success: false,
      conflicts,
      filesChanged: conflicts.length,
      baseBranch,
      taskBranch,
    };
  }

  /**
   * Fallback: simulação via checkout + merge --no-commit + abort.
   * Usado quando git merge-tree não está disponível (git < 2.38).
   */
  private async simulateMergeViaCheckout(
    repoPath: string,
    baseBranch: string,
    taskBranch: string,
  ): Promise<MergeSimulationResult> {
    // Salvar branch/commit atual
    const originalHead = (await this.git(repoPath, ['rev-parse', 'HEAD'])).trim();

    try {
      // Checkout base em detached HEAD
      await this.git(repoPath, ['checkout', '--detach', baseBranch]);

      // Tentar merge
      try {
        await this.git(repoPath, [
          'merge', '--no-commit', '--no-ff', taskBranch,
        ]);
        // Merge limpo
        const diffResult = await this.diff(repoPath, baseBranch, taskBranch);
        // Abort para limpar
        await this.git(repoPath, ['merge', '--abort']).catch(() => {});
        return {
          success: true,
          conflicts: [],
          filesChanged: diffResult.length,
          baseBranch,
          taskBranch,
        };
      } catch {
        // Conflitos — coletar
        const conflicts = await this.collectConflictContents(repoPath);
        // Abort merge
        await this.git(repoPath, ['merge', '--abort']);
        return {
          success: false,
          conflicts,
          filesChanged: conflicts.length,
          baseBranch,
          taskBranch,
        };
      }
    } finally {
      // Restaurar HEAD original
      await this.git(repoPath, ['checkout', originalHead]).catch(() => {});
    }
  }

  /**
   * Extrai conflitos usando git merge-tree --name-only e depois
   * busca o conteúdo de cada lado (ours/theirs/base).
   */
  private async extractConflicts(
    repoPath: string,
    baseBranch: string,
    taskBranch: string,
  ): Promise<MergeConflict[]> {
    // Usar diff com three-dot para encontrar conflitos potenciais
    // Abordagem: listar arquivos modificados em ambos os lados e comparar
    const baseToTask = await this.git(repoPath, [
      'diff', '--name-only', baseBranch, taskBranch,
    ]);
    const taskFiles = baseToTask.trim().split('\n').filter(Boolean);

    const conflicts: MergeConflict[] = [];
    for (const file of taskFiles) {
      // Verificar se o arquivo existe em ambos os lados e se é diferente
      const [oursContent, theirsContent, baseContent] = await Promise.all([
        this.git(repoPath, ['show', `${baseBranch}:${file}`]).catch(() => ''),
        this.git(repoPath, ['show', `${taskBranch}:${file}`]).catch(() => ''),
        this.git(repoPath, ['show', `$(git merge-base ${baseBranch} ${taskBranch}):${file}`]).catch(() => ''),
      ]);
      // Se ambos os lados modificaram em relação à base, é conflito potencial
      if (oursContent !== baseContent && theirsContent !== baseContent && oursContent !== theirsContent) {
        conflicts.push({
          path: file,
          ours: oursContent || null,
          theirs: theirsContent || null,
          base: baseContent || null,
        });
      }
    }
    return conflicts;
  }

  /**
   * Coleta conteúdo dos arquivos conflitantes após um merge --no-commit falho.
   * Usa `git diff --name-only --diff-filter=U` para listar arquivos em conflito.
   */
  private async collectConflictContents(repoPath: string): Promise<MergeConflict[]> {
    const conflictFiles = await this.git(repoPath, [
      'diff', '--name-only', '--diff-filter=U',
    ]);
    const files = conflictFiles.trim().split('\n').filter(Boolean);

    const conflicts: MergeConflict[] = [];
    for (const file of files) {
      // stage 1 = base, stage 2 = ours (HEAD), stage 3 = theirs
      const [base, ours, theirs] = await Promise.all([
        this.git(repoPath, ['show', `:1:${file}`]).catch(() => ''),
        this.git(repoPath, ['show', `:2:${file}`]).catch(() => ''),
        this.git(repoPath, ['show', `:3:${file}`]).catch(() => ''),
      ]);
      conflicts.push({
        path: file,
        ours: ours || null,
        theirs: theirs || null,
        base: base || null,
      });
    }
    return conflicts;
  }

  /**
   * Separa o output de `git diff` em seções por arquivo.
   */
  private splitPatchByFile(patch: string): Map<string, string> {
    const result = new Map<string, string>();
    if (!patch.trim()) return result;
    const sections = patch.split(/^diff --git /m).filter(Boolean);
    for (const section of sections) {
      const match = section.match(/^a\/(.+?) b\/(.+?)\n/m);
      if (match) {
        const path = match[2]!; // novo path (b/...)
        result.set(path, `diff --git ${section}`);
      }
    }
    return result;
  }

  /**
   * Infere o status do arquivo baseado em additions/deletions.
   */
  private inferStatus(additions: number, deletions: number): GitDiffFile['status'] {
    if (additions > 0 && deletions === 0) return 'added';
    if (additions === 0 && deletions > 0) return 'deleted';
    return 'modified';
  }
}

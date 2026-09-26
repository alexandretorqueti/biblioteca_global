// @vitest-environment node
/**
 * Testes unitários do GitInspectorService.
 *
 * Mocka child_process.execFile para validar a lógica de parsing e
 * a composição dos comandos git sem executar git real.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GitInspectorService } from '../api/git-inspector.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// Mock de child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Helper para criar o mock de execFile
function mockExecFile(impl: (cmd: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>) {
  const { execFile } = require('node:child_process');
  // O service usa promisify(execFile), então precisamos mockar a versão promisificada.
  // Como o service importa execFile e faz promisify internamente, precisamos mockar
  // de forma que o promisify receba nossa função mock.
  // Abordagem: mockar o módulo inteiro para que execFile seja nossa função async.
  vi.doMock('node:child_process', () => ({
    execFile: vi.fn(impl),
  }));
}

describe('GitInspectorService', () => {
  let service: GitInspectorService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new GitInspectorService();
  });

  // ─── branchExists ────────────────────────────────────────────────────────

  describe('branchExists', () => {
    it('retorna true quando a branch existe', async () => {
      // O service usa execFile via promisify. Vamos mockar o método privado git.
      const spy = vi.spyOn(service as any, 'git').mockResolvedValue('abc123\n');
      const result = await service.branchExists('/repo', 'main');
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith('/repo', ['rev-parse', '--verify', 'refs/heads/main']);
    });

    it('retorna false quando a branch não existe', async () => {
      const spy = vi.spyOn(service as any, 'git').mockRejectedValue(new Error('not a valid ref'));
      const result = await service.branchExists('/repo', 'nonexistent');
      expect(result).toBe(false);
    });
  });

  // ─── listCommits ─────────────────────────────────────────────────────────

  describe('listCommits', () => {
    it('retorna lista de commits formatada', async () => {
      const gitOutput = [
        'abc123def456|abc123d|João Silva|joao@test.com|2026-09-25T10:00:00-03:00|feat: adicionar endpoint git',
        'def789abc012|def789a|Maria Santos|maria@test.com|2026-09-24T15:30:00-03:00|fix: corrigir parse de diff',
      ].join('\n');
      const spy = vi.spyOn(service as any, 'git').mockResolvedValue(gitOutput);

      const commits = await service.listCommits('/repo', 'base-desenvolvimento', 'motor-v3-work/integration-task-1');

      expect(commits).toHaveLength(2);
      expect(commits[0]).toEqual({
        hash: 'abc123def456',
        shortHash: 'abc123d',
        author: 'João Silva',
        authorEmail: 'joao@test.com',
        date: '2026-09-25T10:00:00-03:00',
        message: 'feat: adicionar endpoint git',
      });
      expect(commits[1]!.message).toBe('fix: corrigir parse de diff');
      expect(spy).toHaveBeenCalledWith('/repo', [
        'log', '--format=%H|%h|%an|%ae|%aI|%s', '--no-merges', '--topo-order',
        'base-desenvolvimento..motor-v3-work/integration-task-1',
      ]);
    });

    it('retorna array vazio quando não há commits', async () => {
      vi.spyOn(service as any, 'git').mockResolvedValue('');
      const commits = await service.listCommits('/repo', 'base', 'task');
      expect(commits).toEqual([]);
    });

    it('preserva pipes na mensagem do commit', async () => {
      const gitOutput = 'abc123|abc|Author|a@b.com|2026-09-25T10:00:00-03:00|feat: pipe | in message';
      vi.spyOn(service as any, 'git').mockResolvedValue(gitOutput);
      const commits = await service.listCommits('/repo', 'base', 'task');
      expect(commits[0]!.message).toBe('feat: pipe | in message');
    });
  });

  // ─── listTree ────────────────────────────────────────────────────────────

  describe('listTree', () => {
    it('retorna árvore de arquivos formatada', async () => {
      // Formato real: mode SP type SP hash SP size TAB path
      const gitOutput = [
        '100644 blob abc123    1234\tsrc/main.ts',
        '100644 blob def456    5678\tsrc/utils.ts',
        '040000 tree ghi789       -\tsrc/nested',
      ].join('\n');
      // Primeira chamada: rev-parse (verificação); segunda: ls-tree
      const spy = vi.spyOn(service as any, 'git')
        .mockResolvedValueOnce('abc123\n') // rev-parse
        .mockResolvedValueOnce(gitOutput); // ls-tree

      const tree = await service.listTree('/repo', 'HEAD');

      expect(tree).toHaveLength(3);
      expect(tree[0]).toEqual({ path: 'src/main.ts', type: 'blob', size: 1234, mode: '100644' });
      expect(tree[2]).toEqual({ path: 'src/nested', type: 'tree', size: undefined, mode: '040000' });
    });

    it('usa HEAD quando ref não informado', async () => {
      const spy = vi.spyOn(service as any, 'git')
        .mockResolvedValueOnce('abc\n')
        .mockResolvedValueOnce('');
      await service.listTree('/repo');
      expect(spy).toHaveBeenCalledWith('/repo', ['rev-parse', '--verify', 'HEAD']);
    });

    it('lança NotFoundException quando ref não existe', async () => {
      vi.spyOn(service as any, 'git').mockRejectedValueOnce(new Error('bad ref'));
      await expect(service.listTree('/repo', 'nonexistent-ref')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getFileContent ──────────────────────────────────────────────────────

  describe('getFileContent', () => {
    it('retorna conteúdo do arquivo no ref', async () => {
      const content = 'console.log("hello world");\n';
      vi.spyOn(service as any, 'git')
        .mockResolvedValueOnce('abc\n') // rev-parse
        .mockResolvedValueOnce(content); // show

      const result = await service.getFileContent('/repo', 'HEAD', 'src/main.ts');
      expect(result).toBe(content);
    });

    it('lança BadRequestException sem ref', async () => {
      await expect(service.getFileContent('/repo', '', 'file.ts')).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequestException sem path', async () => {
      await expect(service.getFileContent('/repo', 'HEAD', '')).rejects.toThrow(BadRequestException);
    });
  });

  // ─── diff ────────────────────────────────────────────────────────────────

  describe('diff', () => {
    it('retorna diff estruturado por arquivo', async () => {
      const numstat = '10\t5\tsrc/main.ts\n3\t0\tsrc/new.ts\n0\t7\tsrc/old.ts\n';
      const patch = [
        'diff --git a/src/main.ts b/src/main.ts\nindex abc..def 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,3 +1,5 @@\n+new line\n context\n',
        'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3\n',
        'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,7 +0,0 @@\n-old1\n',
      ].join('');

      vi.spyOn(service as any, 'git')
        .mockResolvedValueOnce('abc\n') // rev-parse from
        .mockResolvedValueOnce('def\n') // rev-parse to
        .mockResolvedValueOnce(numstat) // numstat
        .mockResolvedValueOnce(patch);  // patch

      const files = await service.diff('/repo', 'base', 'task');

      expect(files).toHaveLength(3);
      expect(files[0]).toMatchObject({ path: 'src/main.ts', status: 'modified', additions: 10, deletions: 5 });
      expect(files[1]).toMatchObject({ path: 'src/new.ts', status: 'added', additions: 3, deletions: 0 });
      expect(files[2]).toMatchObject({ path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 7 });
    });

    it('lança BadRequestException sem from/to', async () => {
      await expect(service.diff('/repo', '', 'to')).rejects.toThrow(BadRequestException);
      await expect(service.diff('/repo', 'from', '')).rejects.toThrow(BadRequestException);
    });
  });

  // ─── simulateMerge ──────────────────────────────────────────────────────

  describe('simulateMerge', () => {
    it('retorna success=true quando merge é limpo', async () => {
      // branchExists (2x) + merge-tree (sucesso) + diff (2x rev-parse + numstat + patch)
      vi.spyOn(service as any, 'git')
        .mockResolvedValueOnce('abc\n') // branchExists base
        .mockResolvedValueOnce('def\n') // branchExists task
        .mockResolvedValueOnce('tree-hash-abc123\n') // merge-tree sucesso
        .mockResolvedValueOnce('a\n') // rev-parse from (diff)
        .mockResolvedValueOnce('b\n') // rev-parse to (diff)
        .mockResolvedValueOnce('5\t2\tfile.ts\n') // numstat
        .mockResolvedValueOnce('diff --git a/file.ts b/file.ts\n'); // patch

      const result = await service.simulateMerge('/repo', 'base', 'task');

      expect(result.success).toBe(true);
      expect(result.conflicts).toEqual([]);
      expect(result.baseBranch).toBe('base');
      expect(result.taskBranch).toBe('task');
    });

    it('retorna conflicts quando merge falha', async () => {
      const mergeTreeError = Object.assign(new Error('conflict'), {
        stdout: 'changed in both',
      });
      vi.spyOn(service as any, 'git')
        .mockResolvedValueOnce('abc\n') // branchExists base
        .mockResolvedValueOnce('def\n') // branchExists task
        .mockRejectedValueOnce(mergeTreeError) // merge-tree falha (conflitos)
        // extractConflicts: diff --name-only
        .mockResolvedValueOnce('src/conflict.ts\n')
        // 3x show para ours/theirs/base
        .mockResolvedValueOnce('ours content')
        .mockResolvedValueOnce('theirs content')
        .mockResolvedValueOnce('base content');

      const result = await service.simulateMerge('/repo', 'base', 'task');

      expect(result.success).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        path: 'src/conflict.ts',
        ours: 'ours content',
        theirs: 'theirs content',
        base: 'base content',
      });
    });

    it('lança NotFoundException quando branch não existe', async () => {
      vi.spyOn(service as any, 'git').mockRejectedValueOnce(new Error('not found'));
      // branchExists retorna false para a primeira branch
      const spy = vi.spyOn(service as any, 'git').mockRejectedValue(new Error('not found'));
      await expect(service.simulateMerge('/repo', 'nonexistent', 'task')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── splitPatchByFile (private, tested via diff) ────────────────────────

  describe('splitPatchByFile (via diff)', () => {
    it('separa patches de múltiplos arquivos', () => {
      const patch = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
diff --git a/file2.ts b/file2.ts
new file mode 100644
--- /dev/null
+++ b/file2.ts
@@ -0,0 +1 @@
+content`;

      const result = (service as any).splitPatchByFile(patch);
      expect(result.size).toBe(2);
      expect(result.has('file1.ts')).toBe(true);
      expect(result.has('file2.ts')).toBe(true);
    });
  });

  // ─── inferStatus (private) ──────────────────────────────────────────────

  describe('inferStatus (via diff)', () => {
    it('detecta added (só additions)', () => {
      expect((service as any).inferStatus(5, 0)).toBe('added');
    });

    it('detecta deleted (só deletions)', () => {
      expect((service as any).inferStatus(0, 5)).toBe('deleted');
    });

    it('detecta modified (ambos)', () => {
      expect((service as any).inferStatus(5, 3)).toBe('modified');
    });
  });
});

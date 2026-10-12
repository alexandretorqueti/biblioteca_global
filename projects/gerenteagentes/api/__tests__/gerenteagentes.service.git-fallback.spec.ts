// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GerenteAgentesService } from '../gerenteagentes.service';

function serviceWithFacts(facts: Record<string, string | null>, git: Record<string, unknown>) {
  const service = Object.create(GerenteAgentesService.prototype) as GerenteAgentesService & Record<string, unknown>;
  const rows = [
    [{ projetoId: 7, externalId: 'task-p2-985' }],
    [{ repoPath: '/repo/projects/gerenteagentes' }],
    [facts],
  ];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows.shift() ?? []) }),
      }),
    })),
  };
  (service as any).dbDoMotor = vi.fn().mockResolvedValue(db);
  (service as any).resolverRepoRootESubdir = vi.fn().mockResolvedValue({ repoRoot: '/repo', projectSubdir: 'projects/gerenteagentes' });
  (service as any).gitInspector = git;
  return service;
}

describe('resolverContextoGitTarefa — evidência persistida', () => {
  it('mantém a branch quando ela existe', async () => {
    const service = serviceWithFacts({ integrationCommitSha: 'a'.repeat(40), baseCommitSha: 'b'.repeat(40), mergeCommitSha: null }, {
      branchExists: vi.fn().mockResolvedValue(true),
      commitExists: vi.fn(),
    });

    const context = await (service as any).resolverContextoGitTarefa({} as never, 985);
    expect(context.taskRef).toBe('motor-v3-work/integration-task-p2-985');
    expect(context.branchExists).toBe(true);
    expect((service as any).gitInspector.commitExists).not.toHaveBeenCalled();
  });

  it('usa o SHA persistido quando a branch foi removida', async () => {
    const sha = 'a'.repeat(40);
    const service = serviceWithFacts({ integrationCommitSha: sha, baseCommitSha: 'b'.repeat(40), mergeCommitSha: null }, {
      branchExists: vi.fn().mockResolvedValue(false),
      commitExists: vi.fn().mockResolvedValue(true),
    });

    const context = await (service as any).resolverContextoGitTarefa({} as never, 985);
    expect(context.taskRef).toBe(sha);
    expect((service as any).gitInspector.commitExists).toHaveBeenCalledWith('/repo', sha);
  });

  it('rejeita tarefa sem SHA persistido ou com objeto inexistente', async () => {
    const missingSha = serviceWithFacts({ integrationCommitSha: null, baseCommitSha: null, mergeCommitSha: null }, {
      branchExists: vi.fn().mockResolvedValue(false),
      commitExists: vi.fn(),
    });
    await expect((missingSha as any).resolverContextoGitTarefa({} as never, 985)).rejects.toThrow(/não há evidência/);

    const missingObject = serviceWithFacts({ integrationCommitSha: 'a'.repeat(40), baseCommitSha: null, mergeCommitSha: null }, {
      branchExists: vi.fn().mockResolvedValue(false),
      commitExists: vi.fn().mockResolvedValue(false),
    });
    await expect((missingObject as any).resolverContextoGitTarefa({} as never, 985)).rejects.toThrow(/não há evidência/);
  });
});

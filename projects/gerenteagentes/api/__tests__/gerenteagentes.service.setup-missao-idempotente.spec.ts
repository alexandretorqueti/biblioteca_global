// @vitest-environment node
/**
 * BRIEF-TAREFA-SETUP-IDEMPOTENTE-E-EVIDENCIA (tarefa 1102, subtarefa 1554):
 * - §A missão idempotente: projeto existente → MODO VERIFICAÇÃO com inventário
 *   do estado real e proibição explícita de sobrescrita (em especial
 *   CONTEXTO-ANALISTA.md); projeto novo → comportamento atual preservado;
 * - §B evidência smoke_test inegociável: schema JSON exato + aviso de reprova
 *   por prosa + auto-checagem antes do ::DONE:: (monorepo e standalone);
 * - detecção de estado (detectarEstadoProjetoSetup) com FS/banco mockados.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { GerenteAgentesService, type EstadoProjetoSetup } from '../gerenteagentes.service';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn((_p: unknown) => false),
  readFileSync: vi.fn((_p: unknown, _enc?: unknown): string => {
    throw new Error('ENOENT');
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    default: { ...actual, existsSync: fsMocks.existsSync, readFileSync: fsMocks.readFileSync },
  };
});

const PROJETO = {
  id: 7,
  slug: 'gestao-tarefas',
  nome: 'Gestão de Tarefas Global',
  descricao: 'Sistema de gestão de tarefas',
  especificacao: 'Especificação captada pela Isa.',
};

const CONFIG_MOTOR = {
  layout: 'monorepo' as const,
  repoPath: null,
  branchTrabalho: null,
  gitRemote: null,
};

type ServicePrivado = {
  montarMissaoSetup: (
    projeto: unknown,
    plataformaProjetoId: number,
    plano: null,
    config: unknown,
    estado?: EstadoProjetoSetup | null,
  ) => string;
  detectarEstadoProjetoSetup: (
    db: unknown,
    slug: string,
    plataformaProjetoId: number,
    repoPath: string | null,
  ) => Promise<EstadoProjetoSetup>;
};

function criarService(): GerenteAgentesService {
  const config = { get: (_key: string) => undefined } as unknown as ConfigService;
  return new GerenteAgentesService(
    { obter: () => Promise.resolve({}) } as never,
    {} as never,
    {} as never,
    config,
  );
}

function montar(service: GerenteAgentesService, estado: EstadoProjetoSetup | null = null): string {
  return (service as unknown as ServicePrivado).montarMissaoSetup(PROJETO, 9, null, CONFIG_MOTOR, estado);
}

function estadoFixture(overrides: Partial<EstadoProjetoSetup> = {}): EstadoProjetoSetup {
  return {
    raizMonorepo: '/repo-fake',
    pastaProjeto: true,
    bancoExiste: true,
    migrationsAplicadas: true,
    projetoExiste: true,
    artefatos: [
      { nome: 'pasta projects/gestao-tarefas/', presente: true, detalhe: null },
      {
        nome: 'projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md',
        presente: true,
        detalhe: 'com conteúdo além do bootstrap — NÃO sobrescrever',
      },
      { nome: 'banco projeto_9', presente: true, detalhe: null },
      { nome: 'registro 2.1 em apps/api schema-registry.ts', presente: false, detalhe: null },
    ],
    ...overrides,
  };
}

describe('montarMissaoSetup — §A projeto NOVO (comportamento atual preservado)', () => {
  it('sem estado detectado → missão de criação, sem MODO VERIFICAÇÃO', () => {
    const missao = montar(criarService(), null);

    expect(missao).toContain('Crie a pasta do projeto em projects/gestao-tarefas');
    expect(missao).toContain('Crie também projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md a partir do modelo');
    expect(missao).toContain('Crie o banco projeto_9');
    expect(missao).toContain('1.5. Execute as migrations.');
    expect(missao).not.toContain('MODO VERIFICAÇÃO');
    expect(missao).not.toContain('PROJETO JÁ EXISTENTE');
  });

  it('estado detectado sem nenhum artefato → continua missão de criação', () => {
    const missao = montar(criarService(), estadoFixture({
      projetoExiste: false,
      pastaProjeto: false,
      bancoExiste: false,
      migrationsAplicadas: false,
      artefatos: [{ nome: 'pasta projects/gestao-tarefas/', presente: false, detalhe: null }],
    }));

    expect(missao).not.toContain('MODO VERIFICAÇÃO');
    expect(missao).toContain('Crie a pasta do projeto');
  });
});

describe('montarMissaoSetup — §A projeto EXISTENTE (MODO VERIFICAÇÃO)', () => {
  it('abre com seção explícita, inventário detectado e regras anti-sobrescrita', () => {
    const missao = montar(criarService(), estadoFixture());

    expect(missao).toContain('PROJETO JÁ EXISTENTE — MODO VERIFICAÇÃO');
    // Inventário do estado real listado na própria missão.
    expect(missao).toContain('Estado real detectado no momento da montagem desta missão');
    expect(missao).toContain('- pasta projects/gestao-tarefas/: EXISTE');
    expect(missao).toContain(
      '- projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md: EXISTE (com conteúdo além do bootstrap — NÃO sobrescrever)',
    );
    expect(missao).toContain('- registro 2.1 em apps/api schema-registry.ts: AUSENTE');
    // Regras inegociáveis.
    expect(missao).toContain('crie SOMENTE o que estiver faltando');
    expect(missao).toContain('NUNCA sobrescreva, regenere');
    expect(missao).toContain('NUNCA resete,');
  });

  it('NÃO instrui sobrescrever CONTEXTO-ANALISTA.md / ESPECIFICACAO.md / banco', () => {
    const missao = montar(criarService(), estadoFixture());

    expect(missao).not.toContain(
      'Crie também projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md a partir do modelo',
    );
    expect(missao).not.toContain('Grave o conteúdo da especificação acima em projects/gestao-tarefas/docs/ESPECIFICACAO.md');
    expect(missao).not.toContain('Crie o banco projeto_9');
    expect(missao).toContain('se existir, NÃO modifique');
    expect(missao).toContain('SOMENTE se o arquivo não existir');
    expect(missao).toContain('NÃO sobrescreva');
    expect(missao).toContain('NÃO o recrie');
    expect(missao).toContain('apenas as migrations PENDENTES');
    expect(missao).toContain('nunca duplique entradas');
  });
});

describe('montarMissaoSetup — §B evidência smoke_test inegociável', () => {
  it.each([
    ['projeto novo', null],
    ['projeto existente', estadoFixture()],
  ])('%s → missão contém schema JSON da evidência e aviso de reprova por prosa', (_caso, estado) => {
    const missao = montar(criarService(), estado);

    expect(missao).toContain(
      '{"smoke_test":{"url":"http://...","method":"GET","status":200,"response_body":"...","timestamp":"2026-..."}}',
    );
    expect(missao).toContain('REPROVA o setup e desperdiça a execução inteira');
    expect(missao).toContain('Resultado em PROSA');
    // Auto-checagem de formato antes do ::DONE::.
    expect(missao).toContain('4.4. ANTES de marcar ::DONE::, auto-cheque o formato do seu resultado final');
    expect(missao).toContain("jq -e '.smoke_test.status'");
  });

  it('standalone → mesma exigência de JSON + aviso de prosa + auto-checagem', () => {
    const service = criarService();
    const missao = (service as unknown as ServicePrivado).montarMissaoSetup(
      { ...PROJETO, slug: 'consoleopenclaw' },
      12,
      null,
      {
        layout: 'standalone',
        repoPath: '/repo/consoleopenclaw',
        branchTrabalho: 'main',
        gitRemote: 'git@github.com:global/openclaw-console.git',
      },
    );

    expect(missao).toContain('"smoke_test"');
    expect(missao).toContain('REPROVA o setup');
    expect(missao).toContain('Resultado em PROSA');
    expect(missao).toContain("jq -e '.smoke_test.status'");
  });
});

describe('detectarEstadoProjetoSetup — detecção do estado real', () => {
  const RAIZ = '/repo-fake';

  beforeEach(() => {
    process.env.REPO_PATH = RAIZ;
    delete process.env.MOTOR_REPO_ROOT_CONTAINER;
  });

  afterEach(() => {
    delete process.env.REPO_PATH;
    vi.clearAllMocks();
  });

  function mockFs(existentes: Set<string>, conteudos: Record<string, string>): void {
    fsMocks.existsSync.mockImplementation((caminho: unknown) => {
      const p = String(caminho);
      if (p === `${RAIZ}/apps` || p === `${RAIZ}/projects`) return true;
      return existentes.has(p);
    });
    fsMocks.readFileSync.mockImplementation((caminho: unknown) => {
      const p = String(caminho);
      if (p in conteudos) return conteudos[p]!;
      throw new Error(`ENOENT: ${p}`);
    });
  }

  function dbMock(bancoExiste: boolean, totalTabelas = 5) {
    return {
      execute: vi
        .fn()
        .mockResolvedValueOnce(bancoExiste ? [[{ SCHEMA_NAME: 'projeto_9' }]] : [[]])
        .mockResolvedValueOnce([[{ total: totalTabelas }]]),
    };
  }

  it('projeto existente com artefatos → inventário presente e projetoExiste=true', async () => {
    mockFs(
      new Set([
        `${RAIZ}/projects/gestao-tarefas`,
        `${RAIZ}/projects/gestao-tarefas/docs/ESPECIFICACAO.md`,
        `${RAIZ}/projects/gestao-tarefas/schema.ts`,
        `${RAIZ}/projects/gestao-tarefas/config.ts`,
      ]),
      {
        [`${RAIZ}/projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md`]:
          '# Contexto do Analista\n## Identidade técnica\nAPI NestJS real, preenchida pelo Analista.',
        [`${RAIZ}/apps/api/src/modules/crud/schema-registry.ts`]:
          'export const x = new Map([["gestao-tarefas", coletarTabelas(s)]]);',
        [`${RAIZ}/apps/web/src/project/registry/projects.ts`]:
          'export const projectConfigs = { "gestao-tarefas": gestaoTarefasConfig };',
        [`${RAIZ}/apps/api/Dockerfile`]: 'COPY projects/gestao-tarefas/package.json projects/gestao-tarefas/package.json',
      },
    );

    const estado = await (criarService() as unknown as ServicePrivado).detectarEstadoProjetoSetup(
      dbMock(true),
      'gestao-tarefas',
      9,
      null,
    );

    expect(estado.raizMonorepo).toBe(RAIZ);
    expect(estado.pastaProjeto).toBe(true);
    expect(estado.bancoExiste).toBe(true);
    expect(estado.migrationsAplicadas).toBe(true);
    expect(estado.projetoExiste).toBe(true);
    const porNome = new Map(estado.artefatos.map((a) => [a.nome, a]));
    expect(porNome.get('projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md')).toMatchObject({
      presente: true,
      detalhe: 'com conteúdo além do bootstrap — NÃO sobrescrever',
    });
    expect(porNome.get('projects/gestao-tarefas/docs/ESPECIFICACAO.md')?.presente).toBe(true);
    expect(porNome.get('registro 2.1 em apps/api schema-registry.ts')?.presente).toBe(true);
    expect(porNome.get('registro 2.2 em apps/web registry projects.ts')?.presente).toBe(true);
    expect(porNome.get('registro 2.5 COPY em apps/api/Dockerfile')?.presente).toBe(true);
    expect(porNome.get('banco projeto_9')?.presente).toBe(true);
    expect(porNome.get('migrations aplicadas em projeto_9')?.presente).toBe(true);
  });

  it('CONTEXTO-ANALISTA.md só com template bootstrap → detalhe sinaliza bootstrap', async () => {
    mockFs(new Set([`${RAIZ}/projects/gestao-tarefas`]), {
      [`${RAIZ}/projects/gestao-tarefas/docs/CONTEXTO-ANALISTA.md`]:
        '# Contexto do Analista\n> Status: bootstrap pendente.\n## Identidade técnica\n_A preencher após inspeção inicial._',
    });

    const estado = await (criarService() as unknown as ServicePrivado).detectarEstadoProjetoSetup(
      dbMock(false),
      'gestao-tarefas',
      9,
      null,
    );

    const contexto = estado.artefatos.find((a) => a.nome.endsWith('CONTEXTO-ANALISTA.md'));
    expect(contexto).toMatchObject({ presente: true, detalhe: 'somente template bootstrap' });
  });

  it('projeto inexistente (nada no FS, banco ausente) → projetoExiste=false', async () => {
    mockFs(new Set(), {});

    const estado = await (criarService() as unknown as ServicePrivado).detectarEstadoProjetoSetup(
      dbMock(false),
      'gestao-tarefas',
      9,
      null,
    );

    expect(estado.pastaProjeto).toBe(false);
    expect(estado.bancoExiste).toBe(false);
    expect(estado.migrationsAplicadas).toBeNull();
    expect(estado.projetoExiste).toBe(false);
    expect(estado.artefatos.every((a) => !a.presente)).toBe(true);
  });

  it('banco indisponível (information_schema falha) → melhor esforço, não lança', async () => {
    mockFs(new Set(), {});
    const db = { execute: vi.fn().mockRejectedValue(new Error('conexão recusada')) };

    const estado = await (criarService() as unknown as ServicePrivado).detectarEstadoProjetoSetup(
      db,
      'gestao-tarefas',
      9,
      null,
    );

    expect(estado.bancoExiste).toBeNull();
    expect(estado.projetoExiste).toBe(false);
    const banco = estado.artefatos.find((a) => a.nome === 'banco projeto_9');
    expect(banco).toMatchObject({ presente: false, detalhe: 'desconhecido (information_schema indisponível)' });
  });
});

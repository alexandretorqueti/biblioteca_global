// @vitest-environment node
/**
 * Geração Macro F1 (task-p2-1056, subtarefa 5) — aprovação do plano e
 * materialização de tarefas (docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §3.2/§4):
 * - approve materializa em transação única: cadeia topológica linear
 *   (depends_on_task_id), external_id macro-<slug>-<n> idempotente,
 *   roteamento por executor, auto_start conforme o plano, lacunas_biblioteca,
 *   ESPEC-CRUD.md, events/outboxes e chat do projeto;
 * - reject não cria nada; revise volta a running com feedback;
 * - requerAgenteDedicado=false + tarefa agente-projeto → 422 sem criar nada;
 * - estado inválido → 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { GerenteAgentesService } from '../gerenteagentes.service';
import {
  tarefas,
  tarefaDependencias,
  tarefaEventos,
  projetoChats,
  projetosCaptados,
  geracoesProjeto,
  lacunasBiblioteca,
  motorOutbox,
  realtimeEventOutbox,
  projetoMotorConfig,
} from '../../schema';

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async (..._args: unknown[]) => undefined),
  writeFile: vi.fn(async (..._args: unknown[]) => undefined),
  existsSync: vi.fn(() => false),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    mkdir: fsMocks.mkdir,
    writeFile: fsMocks.writeFile,
    default: { ...actual, mkdir: fsMocks.mkdir, writeFile: fsMocks.writeFile },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    default: { ...actual, existsSync: fsMocks.existsSync },
  };
});

// ---------------------------------------------------------------------------
// Fixture de plano válido no contrato §5 (forma "plano", normalizada).
// ---------------------------------------------------------------------------
function planoFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'plano',
    classificacaoSistema: 'misto',
    requerAgenteDedicado: true,
    requisitos: [
      { id: 'REQ-F-001', texto: 'Cadastro de clientes', origem: '§1', classificacao: 'crud' },
      { id: 'REQ-F-002', texto: 'Painel personalizado', origem: '§2', classificacao: 'custom' },
      { id: 'REQ-F-003', texto: 'Exportação fiscal', origem: '§3', classificacao: 'lacuna' },
    ],
    especificacaoCrud: {
      entidades: [
        { nome: 'Cliente', campos: ['nome', 'cpf'], mascarasValidacoes: ['CPF 000.000.000-00'], menu: 'Cadastros' },
      ],
      observacoes: 'Entidade raiz do projeto.',
    },
    tarefas: [
      {
        seq: 1,
        titulo: 'Modelo de dados e CRUD base',
        objetivo: 'Definir entidades e telas CRUD padrão',
        escopo: 'Entra: schema/config. Não entra: telas custom.',
        aceite: ['config.ts gerado a partir do ESPEC-CRUD.md', 'CRUD de Cliente funcional'],
        requisitos: ['REQ-F-001'],
        executor: 'biblioteca-global',
        depende_de: [],
        auto_start: true,
        risco: 'baixo',
      },
      {
        seq: 2,
        titulo: 'Painel personalizado de acompanhamento',
        objetivo: 'Tela custom do projeto',
        escopo: 'Entra: painel. Não entra: relatórios fiscais.',
        aceite: ['Painel renderiza dados do projeto'],
        requisitos: ['REQ-F-002'],
        executor: 'agente-projeto',
        depende_de: [1],
        auto_start: false,
        risco: 'medio',
      },
    ],
    matrizCobertura: [
      { req: 'REQ-F-001', cobertoPor: 'tarefa:1' },
      { req: 'REQ-F-002', cobertoPor: 'tarefa:2' },
      { req: 'REQ-F-003', cobertoPor: 'fora_de_fase', justificativa: 'lacuna da biblioteca' },
    ],
    lacunas: [],
    lacunasBiblioteca: [
      { funcionalidade: 'Exportação fiscal', req: 'REQ-F-003', contexto: 'Biblioteca não cobre nativamente' },
    ],
    riscos: [],
    foraDeFase: [{ req: 'REQ-F-003', motivo: 'lacuna da biblioteca registrada' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Banco fake: roteia selects por tabela com fila de respostas e captura
// inserts/updates (padrão dos specs existentes em api/__tests__).
// ---------------------------------------------------------------------------
interface CenarioOpts {
  geracaoStatus?: string;
  tasks?: unknown;
  tarefasExistentes?: Array<Record<string, unknown>>;
  lacunasExistentes?: Array<Record<string, unknown>>;
  biblioteca?: Record<string, unknown> | null;
  motorConfig?: Array<Record<string, unknown>>;
  geracaoExiste?: boolean;
}

function montarCenario(opts: CenarioOpts = {}) {
  const projetoCaptado = { id: 7, slug: 'gestao-tarefas', nome: 'Gestão de Tarefas Global' };
  const geracao = {
    id: 33,
    projetoId: 7,
    status: opts.geracaoStatus ?? 'awaiting_approval',
    tasks: opts.tasks ?? planoFixture(),
    feedback: null,
  };
  const biblioteca =
    opts.biblioteca === undefined ? { id: 3, slug: 'biblioteca-global', ativo: true } : opts.biblioteca;
  const motorConfig = opts.motorConfig ?? [{ repoPath: '/repo/projects/gestao-tarefas' }];

  const filas = new Map<unknown, Array<Array<Record<string, unknown>>>>();
  filas.set(projetosCaptados, [[projetoCaptado], biblioteca ? [biblioteca] : []]);
  filas.set(geracoesProjeto, [opts.geracaoExiste === false ? [] : [geracao]]);
  filas.set(tarefas, [opts.tarefasExistentes ?? []]);
  filas.set(projetoMotorConfig, [motorConfig]);
  filas.set(lacunasBiblioteca, [opts.lacunasExistentes ?? []]);

  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  let tarefaIdSeq = 101;

  const consumir = (table: unknown): Array<Record<string, unknown>> => {
    const fila = filas.get(table);
    return fila && fila.length > 0 ? fila.shift()! : [];
  };

  const roteador: any = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond?: unknown) => {
          const rows = consumir(table);
          return Object.assign(Promise.resolve(rows), {
            limit: async (_n?: number) => rows,
            orderBy: async () => rows,
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return [{ insertId: table === tarefas ? tarefaIdSeq++ : 1 }];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, set: values });
        return { where: async (_cond?: unknown) => undefined };
      },
    }),
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(roteador),
  };

  const config = { get: (_key: string) => undefined } as unknown as ConfigService;
  const service = new GerenteAgentesService(
    { obter: () => Promise.resolve(roteador) } as never,
    {} as never,
    {} as never,
    config,
  );

  const insertsNaTabela = (table: unknown) => inserts.filter((item) => item.table === table);
  const updatesNaTabela = (table: unknown) => updates.filter((item) => item.table === table);

  return { service, inserts, updates, insertsNaTabela, updatesNaTabela, geracao, projetoCaptado };
}

const projetoToken = { id: 640, slug: 'gerenteagentes' } as never;

function chamarAprovacao(service: GerenteAgentesService, input: Record<string, unknown> = {}) {
  return service.aprovarGeracaoProjeto(projetoToken, 7, 33, {
    decisao: 'approve',
    ator: 'alexandre@globaltecnologia.net',
    ...input,
  } as never);
}

beforeEach(() => {
  fsMocks.mkdir.mockClear();
  fsMocks.writeFile.mockClear();
  fsMocks.existsSync.mockClear();
});

describe('GerenteAgentesService.aprovarGeracaoProjeto — approve (materialização §4)', () => {
  it('materializa tarefas em cadeia topológica linear com roteamento por executor', async () => {
    const { service, insertsNaTabela, updatesNaTabela } = montarCenario();

    const resultado: any = await chamarAprovacao(service);

    expect(resultado.status).toBe('approved');
    expect(resultado.tarefasCriadas).toBe(2);

    const inseridas = insertsNaTabela(tarefas);
    expect(inseridas).toHaveLength(2);

    // Tarefa 1: executor biblioteca-global → projeto captado biblioteca-global (id 3).
    const t1 = inseridas[0]!;
    expect(t1.values).toMatchObject({
      projetoId: 3,
      externalId: 'macro-gestao-tarefas-1',
      titulo: 'Modelo de dados e CRUD base',
      tipo: 'desenvolvimento',
      dependsOnTaskId: null,
      autoStart: true,
      pausedAt: null,
    });
    // Descrição rica: objetivo, escopo, aceite, REQ-* cobertos e apontadores (§4).
    const descricao1 = String(t1.values.descricao);
    expect(descricao1).toContain('## Objetivo');
    expect(descricao1).toContain('## Escopo');
    expect(descricao1).toContain('## Critérios de aceite');
    expect(descricao1).toContain('REQ-F-001');
    expect(descricao1).toContain('projects/gestao-tarefas/docs/ESPECIFICACAO.md');
    expect(descricao1).toContain('projects/gestao-tarefas/docs/ESPEC-CRUD.md');

    // Tarefa 2: executor agente-projeto → projeto captado novo (id 7),
    // depende da anterior na cadeia topológica linear.
    const t2 = inseridas[1]!;
    expect(t2.values).toMatchObject({
      projetoId: 7,
      externalId: 'macro-gestao-tarefas-2',
      dependsOnTaskId: 101,
      autoStart: false,
    });
    expect(String(t2.values.descricao)).toContain('REQ-F-002');

    // tarefa_dependencias espelha a cadeia.
    const dependencias = insertsNaTabela(tarefaDependencias);
    expect(dependencias).toHaveLength(1);
    expect(dependencias[0]!.values).toEqual({ tarefaId: 102, dependeDeTarefaId: 101 });

    // Padrão criarTarefa: evento 'created' + TASK_CREATED + realtime outbox por tarefa.
    const eventos = insertsNaTabela(tarefaEventos);
    expect(eventos).toHaveLength(2);
    expect(eventos[0]!.values).toMatchObject({ evento: 'created', origem: 'usuario' });
    expect(eventos[0]!.values.payload).toMatchObject({ macro: true, geracaoId: 33 });

    const outbox = insertsNaTabela(motorOutbox);
    expect(outbox).toHaveLength(2);
    expect(outbox[0]!.values).toMatchObject({
      type: 'TASK_CREATED',
      taskId: 'macro-gestao-tarefas-1',
      status: 'pending',
    });
    expect(outbox[0]!.values.payloadJson).toMatchObject({
      taskId: 'macro-gestao-tarefas-1',
      taskDatabaseId: 101,
      managedProjectId: 3,
      paused: false,
    });
    expect(outbox[1]!.values.payloadJson).toMatchObject({ managedProjectId: 7 });

    const realtime = insertsNaTabela(realtimeEventOutbox);
    expect(realtime).toHaveLength(2);
    expect(realtime[0]!.values).toMatchObject({
      type: 'task.created',
      taskId: 101,
      sourceTaskId: 'macro-gestao-tarefas-1',
      projectId: 640,
      perTaskSeq: 1,
    });

    // Lacunas da biblioteca persistidas com status='aberta', geracao_id e req_id.
    const lacunas = insertsNaTabela(lacunasBiblioteca);
    expect(lacunas).toHaveLength(1);
    expect(lacunas[0]!.values).toMatchObject({
      projetoId: 7,
      geracaoId: 33,
      reqId: 'REQ-F-003',
      funcionalidade: 'Exportação fiscal',
      contexto: 'Biblioteca não cobre nativamente',
      status: 'aberta',
    });

    // Geração → approved com ids/títulos no json tasks.
    const updatesGeracao = updatesNaTabela(geracoesProjeto);
    expect(updatesGeracao).toHaveLength(1);
    expect(updatesGeracao[0]!.set.status).toBe('approved');
    const tasksJson: any = updatesGeracao[0]!.set.tasks;
    expect(tasksJson.kind).toBe('plano');
    expect(tasksJson.materializacao.tarefas).toHaveLength(2);
    expect(tasksJson.materializacao.tarefas[0]).toMatchObject({
      id: 101,
      externalId: 'macro-gestao-tarefas-1',
      titulo: 'Modelo de dados e CRUD base',
      executor: 'biblioteca-global',
      projetoId: 3,
      criada: true,
    });
    expect(tasksJson.materializacao.tarefas[1]).toMatchObject({ id: 102, executor: 'agente-projeto', projetoId: 7 });

    // Chat do projeto registra a decisão.
    const chats = insertsNaTabela(projetoChats);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.values).toMatchObject({ projetoId: 7, role: 'system' });
    expect(String(chats[0]!.values.texto)).toContain('Plano aprovado');
    expect(String(chats[0]!.values.texto)).toContain('2 tarefas macro materializadas');
    expect(String(chats[0]!.values.texto)).toContain('macro-gestao-tarefas-1');

    // ESPEC-CRUD.md gravado em projects/<slug>/docs (via repo_path do projeto).
    expect(fsMocks.mkdir).toHaveBeenCalledWith('/repo/projects/gestao-tarefas/docs', { recursive: true });
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    const [caminho, conteudo] = fsMocks.writeFile.mock.calls[0]!;
    expect(caminho).toBe('/repo/projects/gestao-tarefas/docs/ESPEC-CRUD.md');
    expect(String(conteudo)).toContain('# ESPEC-CRUD — Gestão de Tarefas Global (gestao-tarefas)');
    expect(String(conteudo)).toContain('### Cliente');
    expect(String(conteudo)).toContain('CPF 000.000.000-00');
    expect(resultado.especCrud).toMatchObject({ gravado: true });
  });

  it('é idempotente: external_id existente é reutilizado e não duplica tarefa', async () => {
    const { service, insertsNaTabela, updatesNaTabela } = montarCenario({
      tarefasExistentes: [
        { id: 900, externalId: 'macro-gestao-tarefas-1', projetoId: 3, titulo: 'Modelo de dados e CRUD base' },
      ],
    });

    const resultado: any = await chamarAprovacao(service);

    expect(resultado.tarefasCriadas).toBe(1);
    expect(resultado.tarefasReutilizadas).toBe(1);

    const inseridas = insertsNaTabela(tarefas);
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]!.values).toMatchObject({
      externalId: 'macro-gestao-tarefas-2',
      dependsOnTaskId: 900, // cadeia continua a partir da tarefa já existente
    });

    // Outbox/eventos apenas para a tarefa nova.
    expect(insertsNaTabela(motorOutbox)).toHaveLength(1);
    expect(insertsNaTabela(tarefaEventos)).toHaveLength(1);

    const tasksJson: any = updatesNaTabela(geracoesProjeto)[0]!.set.tasks;
    expect(tasksJson.materializacao.tarefas[0]).toMatchObject({ id: 900, criada: false });
    expect(tasksJson.materializacao.tarefas[1]).toMatchObject({ id: 101, criada: true });
  });

  it('approve com planoEditado re-salva o plano editado em tasks antes de materializar', async () => {
    const planoEditado = planoFixture();
    planoEditado.tarefas[0]!.titulo = 'Título editado pelo dono';
    const { service, insertsNaTabela, updatesNaTabela } = montarCenario();

    const resultado: any = await chamarAprovacao(service, { planoEditado });

    expect(resultado.status).toBe('approved');
    expect(insertsNaTabela(tarefas)[0]!.values.titulo).toBe('Título editado pelo dono');
    const tasksJson: any = updatesNaTabela(geracoesProjeto)[0]!.set.tasks;
    expect(tasksJson.tarefas[0].titulo).toBe('Título editado pelo dono');
    expect(tasksJson.materializacao.tarefas[0].titulo).toBe('Título editado pelo dono');
  });

  it('planoEditado inválido → 422 sem criar nada', async () => {
    const { service, inserts, updates } = montarCenario();

    await expect(
      chamarAprovacao(service, { planoEditado: { kind: 'plano', tarefas: [] } }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(inserts.filter((item) => item.table !== projetoChats)).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('requerAgenteDedicado=false com tarefa agente-projeto → 422 sem criar nada', async () => {
    const { service, inserts, updates } = montarCenario({
      tasks: planoFixture({ requerAgenteDedicado: false }),
    });

    await expect(chamarAprovacao(service)).rejects.toThrow(
      /requerAgenteDedicado=false/,
    );
    await Promise.resolve();
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('projeto executor biblioteca-global ausente → 422 sem criar nada', async () => {
    const { service, inserts, updates } = montarCenario({ biblioteca: null });

    await expect(chamarAprovacao(service)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe('GerenteAgentesService.aprovarGeracaoProjeto — reject/revise', () => {
  it('reject → status rejected, nenhuma tarefa criada, decisão registrada no chat', async () => {
    const { service, insertsNaTabela, updatesNaTabela } = montarCenario();

    const resultado: any = await chamarAprovacao(service, { decisao: 'reject', comentario: 'plano fraco' });

    expect(resultado.status).toBe('rejected');
    expect(resultado.tarefasCriadas).toBe(0);
    expect(insertsNaTabela(tarefas)).toHaveLength(0);
    expect(insertsNaTabela(motorOutbox)).toHaveLength(0);
    expect(insertsNaTabela(lacunasBiblioteca)).toHaveLength(0);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();

    const updatesGeracao = updatesNaTabela(geracoesProjeto);
    expect(updatesGeracao).toHaveLength(1);
    expect(updatesGeracao[0]!.set.status).toBe('rejected');

    const chats = insertsNaTabela(projetoChats);
    expect(chats).toHaveLength(1);
    expect(String(chats[0]!.values.texto)).toContain('rejeitado');
    expect(String(chats[0]!.values.texto)).toContain('plano fraco');
  });

  it('revise → status running com feedback gravado e sem tarefas', async () => {
    const { service, insertsNaTabela, updatesNaTabela } = montarCenario();

    const resultado: any = await chamarAprovacao(service, {
      decisao: 'revise',
      comentario: 'Detalhar multi-tenancy e permissões',
    });

    expect(resultado.status).toBe('running');
    expect(insertsNaTabela(tarefas)).toHaveLength(0);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();

    const updatesGeracao = updatesNaTabela(geracoesProjeto);
    expect(updatesGeracao).toHaveLength(1);
    expect(updatesGeracao[0]!.set).toMatchObject({
      status: 'running',
      feedback: 'Detalhar multi-tenancy e permissões',
      workerId: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });

    const chats = insertsNaTabela(projetoChats);
    expect(chats).toHaveLength(1);
    expect(String(chats[0]!.values.texto)).toContain('Revisão solicitada');
  });

  it('revise sem comentario → 400', async () => {
    const { service, inserts, updates } = montarCenario();
    await expect(chamarAprovacao(service, { decisao: 'revise' })).rejects.toBeInstanceOf(BadRequestException);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe('GerenteAgentesService.aprovarGeracaoProjeto — validações de estado', () => {
  it('geracao fora de awaiting_approval → 409', async () => {
    const { service, inserts, updates } = montarCenario({ geracaoStatus: 'pending' });
    await expect(chamarAprovacao(service)).rejects.toBeInstanceOf(ConflictException);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('segunda aprovação (status já approved) → 409 sem duplicar', async () => {
    const { service, inserts } = montarCenario({ geracaoStatus: 'approved' });
    await expect(chamarAprovacao(service)).rejects.toBeInstanceOf(ConflictException);
    expect(inserts).toHaveLength(0);
  });

  it('geracao inexistente para o projeto → 404', async () => {
    const { service } = montarCenario({ geracaoExiste: false });
    await expect(chamarAprovacao(service)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('decisao inválida → 400', async () => {
    const { service } = montarCenario();
    await expect(chamarAprovacao(service, { decisao: 'talvez' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

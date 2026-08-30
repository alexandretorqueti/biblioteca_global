import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, desc } from 'drizzle-orm';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type {
  ProjetoResumo,
  ModelSelectionTipo,
  ModelSelectionEntry,
} from '@biblioteca-global/shared';
import { ProjectModelSelectionSchema } from '@biblioteca-global/shared';
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from '../../../apps/api/src/modules/crud/project-db.factory';
import { SCHEMA_REGISTRY, type SchemaRegistry } from '../../../apps/api/src/modules/crud/schema-registry';
import {
  tarefas,
  subtarefas,
  tarefaChats,
  projetoChats,
  projetosCaptados,
  geracoesProjeto,
} from '../schema';
import { ProvisionService } from '../../../apps/api/src/modules/provision/provision.service';

@Injectable()
export class GerenteAgentesService {
  private readonly motorUrl: string;
  private readonly motorHostHeader: string;
  private readonly consoleUrl: string;
  private readonly consoleToken: string;

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
    @Inject(ProvisionService) private readonly provisionService: ProvisionService,
    private readonly configService: ConfigService,
  ) {
    // Motor de execução (rodando no container openclaw:6283, exposto via proxy NPM)
    this.motorUrl = this.configService.get<string>('MOTOR_DEV_URL') || 'http://192.168.1.16';
    this.motorHostHeader = this.configService.get<string>('MOTOR_URL_HOST') || 'api.tarefas.localhost';
    // Console OpenClaw (fonte de agentes — st-5)
    this.consoleUrl = this.configService.get<string>('OPENCLAW_CONSOLE_URL') || 'https://openclaw-api.webconnect.com.br';
    this.consoleToken = this.configService.get<string>('OPENCLAW_CONSOLE_TOKEN') || '';
  }

  /**
   * Lista agentes do console OpenClaw (proxy server-side — o token do
   * console nunca vai para o browser). Resposta: { agents: [...] } com
   * id string (ex.: "programador-senior") e name.
   */
  async listarAgentesConsole(): Promise<Array<{ id: string; name: string; model?: string; status?: string }>> {
    const url = new URL(`${this.consoleUrl}/api/agents`);
    const isHttps = url.protocol === 'https:';
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(this.consoleToken ? { Authorization: `Bearer ${this.consoleToken}` } : {}),
      },
      timeout: 10000,
    };
    return new Promise((resolve, reject) => {
      const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new BadRequestException(`Console OpenClaw indisponível (${status})`));
            return;
          }
          try {
            const json = JSON.parse(data) as { agents?: Array<{ id?: string; name?: string; model?: string; status?: string }> };
            resolve(
              (json.agents ?? [])
                .filter((a) => typeof a.id === "string" && a.id.length > 0)
                .map((a) => ({
                  id: a.id!,
                  name: a.name ?? a.id!,
                  ...(a.model ? { model: a.model } : {}),
                  ...(a.status ? { status: a.status } : {}),
                })),
            );
          } catch (e) {
            reject(new BadRequestException(`Console OpenClaw: resposta inválida (${e instanceof Error ? e.message : String(e)})`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }
  /**
   * Lista modelos disponíveis no console OpenClaw (proxy server-side, mesmo
   * padrão de `listarAgentesConsole` — o token do console nunca vai para o
   * browser). GET `${OPENCLAW_CONSOLE_URL}/api/models` → normaliza cada entrada
   * para `{ id, name, provider, alias? }`. O console pode responder
   * `{ models: [...] }` ou um array direto; entradas sem `id` são descartadas.
   */
  async listarModelosConsole(): Promise<Array<{ id: string; name: string; provider: string; alias?: string }>> {
    const url = new URL(`${this.consoleUrl}/api/models`);
    const isHttps = url.protocol === 'https:';
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(this.consoleToken ? { Authorization: `Bearer ${this.consoleToken}` } : {}),
      },
      timeout: 10000,
    };
    return new Promise((resolve, reject) => {
      const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new BadRequestException(`Console OpenClaw indisponível (${status})`));
            return;
          }
          try {
            const json = JSON.parse(data) as { models?: unknown } | unknown[];
            const raw = Array.isArray(json) ? json : (json.models ?? []);
            const lista = Array.isArray(raw) ? raw : [];
            resolve(
              lista
                .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
                .map((m) => ({
                  id: String(m.id ?? ''),
                  name: String(m.name ?? m.id ?? ''),
                  provider: String(m.provider ?? ''),
                  ...(m.alias ? { alias: String(m.alias) } : {}),
                }))
                .filter((m) => m.id.length > 0),
            );
          } catch (e) {
            reject(new BadRequestException(`Console OpenClaw: resposta inválida (${e instanceof Error ? e.message : String(e)})`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    return await this.factory.obter({ id: projeto.id });
  }

  /**
   * Faz requisição HTTP para o motor de tarefas (GerenteAgentes).
   */
  private motorRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const url = new URL(`${this.motorUrl}${path}`);
    const isHttps = url.protocol === 'https:';
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.motorHostHeader ? { Host: this.motorHostHeader } : {}),
      },
      timeout: 15000,
    };
    return new Promise((resolve, reject) => {
      const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, body: data });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => reject(new BadRequestException(`Motor request failed: ${e.message}`)));
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // ============================================================================
  // AÇÕES DE TAREFA
  // ============================================================================

  async iniciarTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    // Permite reiniciar tarefas bloqueadas/falhas/pausadas (não apenas draft/planned)
    const statusPermitidos = ['draft', 'planned', 'blocked', 'failed', 'paused'];
    if (!statusPermitidos.includes(tarefa.status)) {
      throw new BadRequestException(`Tarefa não pode ser iniciada (status: ${tarefa.status})`);
    }

    // ── Ponte com o motor de execução ────────────────────────────────────────
    // A tarefa já existe no motor com o external_id. Chama apenas
    // POST /api/task/:id/start — o motor enfileira (FIFO) e executa.
    const motorId = tarefa.externalId || `task-biblioteca-${tarefa.id}`;
    const start = await this.motorRequest('POST', `/api/task/${encodeURIComponent(motorId)}/start`).catch((e: unknown) => {
      throw new BadRequestException(`Motor indisponível ao iniciar a tarefa: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!start.ok) {
      throw new BadRequestException(`Motor rejeitou o início (${start.status}): ${start.body.slice(0, 200)}`);
    }

    await db
      .update(tarefas)
      .set({ status: 'planned', updatedAt: new Date() })
      .where(eq(tarefas.id, tarefaId));

    return { id: tarefaId, status: 'planned', message: 'Tarefa iniciada no motor', motorId };
  }

  async pausarTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    if (tarefa.status !== 'running') {
      throw new BadRequestException(`Tarefa não pode ser pausada (status: ${tarefa.status})`);
    }

    await db
      .update(tarefas)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(tarefas.id, tarefaId));

    return { id: tarefaId, status: 'paused', message: 'Tarefa pausada' };
  }

  async retomarTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    if (tarefa.status !== 'paused') {
      throw new BadRequestException(`Tarefa não pode ser retomada (status: ${tarefa.status})`);
    }

    await db
      .update(tarefas)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(tarefas.id, tarefaId));

    return { id: tarefaId, status: 'running', message: 'Tarefa retomada' };
  }

  // ============================================================================
  // CHAT DA TAREFA
  // ============================================================================

  async listarChatTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se a tarefa pertence ao projeto
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    const mensagens = await db
      .select()
      .from(tarefaChats)
      .where(eq(tarefaChats.tarefaId, tarefaId))
      .orderBy(tarefaChats.createdAt);

    return mensagens;
  }

  async adicionarMensagemChatTarefa(
    projeto: ProjetoResumo,
    tarefaId: number,
    role: string,
    texto: string,
  ) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se a tarefa pertence ao projeto
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    const [mensagem] = await db
      .insert(tarefaChats)
      .values({
        tarefaId,
        role,
        texto,
        createdAt: new Date(),
      })
      .$returningId();

    if (!mensagem) {
      throw new BadRequestException('Falha ao criar mensagem');
    }

    return { id: mensagem.id, tarefaId, role, texto, createdAt: new Date() };
  }

  // ============================================================================
  // CHAT DO PROJETO
  // ============================================================================

  async listarChatProjeto(projeto: ProjetoResumo, projetoCaptadoId: number) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se o projeto pertence ao escopo
    const [projetoCaptado] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoCaptadoId))
      .limit(1);

    if (!projetoCaptado) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const mensagens = await db
      .select()
      .from(projetoChats)
      .where(eq(projetoChats.projetoId, projetoCaptadoId))
      .orderBy(projetoChats.createdAt);

    return mensagens;
  }

  async adicionarMensagemChatProjeto(
    projeto: ProjetoResumo,
    projetoCaptadoId: number,
    role: string,
    texto: string,
  ) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se o projeto pertence ao escopo
    const [projetoCaptado] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoCaptadoId))
      .limit(1);

    if (!projetoCaptado) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const [mensagem] = await db
      .insert(projetoChats)
      .values({
        projetoId: projetoCaptadoId,
        role,
        texto,
        createdAt: new Date(),
      })
      .$returningId();

    if (!mensagem) {
      throw new BadRequestException('Falha ao criar mensagem');
    }

    return { id: mensagem.id, projetoId: projetoCaptadoId, role, texto, createdAt: new Date() };
  }

  // ============================================================================
  // GERAÇÃO MACRO (START DO PROJETO)
  // ============================================================================

  async iniciarGeracaoProjeto(projeto: ProjetoResumo, projetoCaptadoId: number) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se o projeto pertence ao escopo
    const [projetoCaptado] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoCaptadoId))
      .limit(1);

    if (!projetoCaptado) {
      throw new NotFoundException('Projeto não encontrado');
    }

    // Criar registro de geração
    const [geracao] = await db
      .insert(geracoesProjeto)
      .values({
        projetoId: projetoCaptadoId,
        status: 'pending',
        briefing: `Gerar tarefas macro para o projeto: ${projetoCaptado.nome}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .$returningId();

    if (!geracao) {
      throw new BadRequestException('Falha ao criar geração');
    }

    return {
      geracaoId: geracao.id,
      status: 'pending',
      message: 'Geração de tarefas iniciada',
    };
  }

  async listarGeracoesProjeto(projeto: ProjetoResumo, projetoCaptadoId: number) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se o projeto pertence ao escopo
    const [projetoCaptado] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoCaptadoId))
      .limit(1);

    if (!projetoCaptado) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const geracoes = await db
      .select()
      .from(geracoesProjeto)
      .where(eq(geracoesProjeto.projetoId, projetoCaptadoId))
      .orderBy(desc(geracoesProjeto.createdAt));

    return geracoes;
  }

  // ============================================================================
  // SUBTAREFAS
  // ============================================================================

  /**
   * Detail da tarefa NO MOTOR (proxy): task + subtasks + events + currentSubTask.
   * O motor é a fonte da verdade da execução; a tabela `sub_task` do motor é
   * separada da tabela `subtarefas` da biblioteca (Fase 3 ainda não sincroniza).
   */
  async motorDetailTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);
    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }
    const motorId = tarefa.externalId || String(tarefa.id);
    try {
      // Motor-v2 usa /api/motor/task/:id (retorna dados básicos da tarefa)
      const resp = await this.motorRequest('GET', `/api/motor/task/${encodeURIComponent(motorId)}`);
      if (resp.status === 404) {
        return { motorId, exists: false, message: 'Tarefa ainda não foi enviada ao motor (clique em Iniciar).' };
      }
      if (!resp.ok) {
        throw new BadRequestException(`Motor retornou ${resp.status}: ${resp.body.slice(0, 200)}`);
      }
      const motorTask = JSON.parse(resp.body) as {
        id?: string;
        title?: string;
        status?: string;
        description?: string;
      };
      
      // Busca subtarefas do banco de dados (motor-v2 não retorna subtarefas no endpoint)
      const subtarefasList = await db
        .select({
          id: subtarefas.id,
          seq: subtarefas.seq,
          titulo: subtarefas.titulo,
          status: subtarefas.status,
          deliverCount: subtarefas.deliverCount,
          resultado: subtarefas.resultado,
        })
        .from(subtarefas)
        .where(eq(subtarefas.tarefaId, tarefaId))
        .orderBy(subtarefas.seq);
      
      // Converte para o formato esperado pelo front-end
      const subtasks = subtarefasList.map(s => ({
        seq: s.seq,
        title: s.titulo,
        status: s.status,
        deliverCount: s.deliverCount,
        blockInfo: s.resultado ? { reason: s.resultado } : null,
      }));
      
      // Encontra subtarefa atual (running, verifying, etc)
      const currentSubTask = subtasks.find(s => 
        ['running', 'verifying', 'delivered', 'planning'].includes(s.status)
      ) || null;
      
      return { 
        motorId, 
        exists: true, 
        task: {
          id: motorTask.id || String(tarefaId),
          title: motorTask.title || tarefa.titulo,
          status: motorTask.status || tarefa.status,
        },
        subtasks,
        currentSubTask,
        events: [], // Motor-v2 não tem eventos detalhados ainda
        errors: [],
        models: [],
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Motor indisponível: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async listarSubtarefas(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se a tarefa pertence ao projeto
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    const subtarefasList = await db
      .select()
      .from(subtarefas)
      .where(eq(subtarefas.tarefaId, tarefaId))
      .orderBy(subtarefas.seq);

    return subtarefasList;
  }

  // ============================================================================
  // SELEÇÃO DE MODELOS (proxy p/ motor — task-54)
  // ============================================================================

  /**
   * GET /api/model-selection/:projectKey/:tipo — lista a seleção de modelos do
   * projeto captado para o tipo (DEV/ANALYST/MONITOR). `projectKey` vem da
   * rota (slug do projeto captado, ex.: "biblioteca-global") e é encaminhado
   * ao motor tal qual — NÃO é o slug do projeto logado.
   * 404 do motor (ainda não há seleção) → `entries: []`.
   */
  async getModelSelection(
    projectKey: string,
    tipo: ModelSelectionTipo,
  ): Promise<{ projectKey: string; tipo: ModelSelectionTipo; entries: ModelSelectionEntry[] }> {
    const resp = await this.motorRequest(
      'GET',
      `/api/model-selection/${encodeURIComponent(projectKey)}/${encodeURIComponent(tipo)}`,
    ).catch((e: unknown) => {
      throw new BadRequestException(`Motor indisponível: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (resp.status === 404) {
      return { projectKey, tipo, entries: [] };
    }
    if (!resp.ok) {
      throw new BadRequestException(`Motor retornou ${resp.status}: ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as { projectKey?: string; tipo?: string; entries?: ModelSelectionEntry[] };
    return { projectKey: data.projectKey ?? projectKey, tipo, entries: data.entries ?? [] };
  }

  /**
   * PUT /api/model-selection/:projectKey/:tipo — salva a seleção de modelos do
   * projeto captado (slug da rota) para o tipo. Body validado com o contrato
   * shared (mesmo schema do motor); campos extras são rejeitados antes do proxy.
   */
  async saveModelSelection(
    projectKey: string,
    tipo: ModelSelectionTipo,
    entries: ModelSelectionEntry[],
  ): Promise<{ projectKey: string; tipo: ModelSelectionTipo; entries: ModelSelectionEntry[] }> {
    // Valida localmente contra o contrato shared (strict) antes de enviar ao motor
    const parsed = ProjectModelSelectionSchema.parse({ projectKey, tipo, entries }) as {
      projectKey: string;
      tipo: ModelSelectionTipo;
      entries: ModelSelectionEntry[];
    };

    const resp = await this.motorRequest(
      'PUT',
      `/api/model-selection/${encodeURIComponent(parsed.projectKey)}/${encodeURIComponent(tipo)}`,
      { entries: parsed.entries },
    ).catch((e: unknown) => {
      throw new BadRequestException(`Motor indisponível: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!resp.ok) {
      throw new BadRequestException(`Motor retornou ${resp.status}: ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as { projectKey?: string; tipo?: string; entries?: ModelSelectionEntry[] };
    return { projectKey: data.projectKey ?? parsed.projectKey, tipo, entries: data.entries ?? parsed.entries };
  }

  // ============================================================================
  // INICIAR DESENVOLVIMENTO (integração 1:1 com core)
  // ============================================================================

  async iniciarDesenvolvimento(
    projeto: ProjetoResumo,
    projetoCaptadoId: number,
    email: string,
  ) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se o projeto pertence ao escopo
    const [projetoCaptado] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoCaptadoId))
      .limit(1);

    if (!projetoCaptado) {
      throw new NotFoundException('Projeto não encontrado');
    }

    // Se já tem plataformaProjetoId, retornar (idempotente)
    if (projetoCaptado.plataformaProjetoId) {
      return {
        projetoId: projetoCaptado.id,
        plataformaProjetoId: projetoCaptado.plataformaProjetoId,
        message: 'Projeto já provisionado na plataforma',
      };
    }

    // Chamar ProvisionService para criar o projeto no core
    const provisionResult = await this.provisionService.provisionProject({
      email,
      projetoNome: projetoCaptado.nome,
      projetoSlug: projetoCaptado.slug,
    });

    // Atualizar o projeto_captado com o plataformaProjetoId
    await db
      .update(projetosCaptados)
      .set({
        plataformaProjetoId: provisionResult.projetoId,
        updatedAt: new Date(),
      })
      .where(eq(projetosCaptados.id, projetoCaptadoId));

    return {
      projetoId: projetoCaptado.id,
      plataformaProjetoId: provisionResult.projetoId,
      usuarioId: provisionResult.usuarioId,
      perfil: provisionResult.perfil,
      criado: provisionResult.criado,
      message: 'Desenvolvimento iniciado - projeto provisionado na plataforma',
    };
  }
}

import { Injectable, Inject, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, desc, and } from 'drizzle-orm';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
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
  contatos,
  promptsAgentes,
  promptsMascaras,
  promptsVersoes,
} from '../schema';
import { AGENT_PROMPT_CATALOG } from '../motor-v2/src/prompts/prompt-catalog';
import { markersIn, renderPromptTemplate, validatePromptTemplate } from '../motor-v2/src/prompts/PromptTemplateEngine';
import { ProvisionService } from '../../../apps/api/src/modules/provision/provision.service';
import { TASK_STATUS_STARTABLE } from '../motor-v2/src/shared/task-statuses';
import { RealtimeService } from '../../../apps/api/src/modules/realtime/realtime.service';

@Injectable()
export class GerenteAgentesService {
  private readonly logger = new Logger(GerenteAgentesService.name);
  private readonly motorUrl: string;
  private readonly motorHostHeader: string;
  private readonly motorVersao: string;
  private readonly motorV2Url: string;
  private readonly consoleUrl: string;
  private readonly consoleToken: string;

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
    @Inject(ProvisionService) private readonly provisionService: ProvisionService,
    private readonly configService: ConfigService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {
    // Motor de execução (rodando no container openclaw:6283, exposto via proxy NPM)
    this.motorUrl = this.configService.get<string>('MOTOR_DEV_URL') || 'http://192.168.1.16';
    this.motorHostHeader = this.configService.get<string>('MOTOR_URL_HOST') || 'api.tarefas.localhost';
    // Motor-v2: roda junto da API no mesmo container (entrypoint), habilitado
    // por MOTOR_VERSION=v2. Os endpoints v2 ficam em /api/motor/* na porta
    // MOTOR_API_PORT — sem proxy, sem Host header.
    this.motorVersao = this.configService.get<string>('MOTOR_VERSION') || 'v1';
    const motorV2Porta = this.configService.get<string>('MOTOR_API_PORT') || '3010';
    this.motorV2Url = `http://127.0.0.1:${motorV2Porta}`;
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

  /**
   * Sincroniza agentes do OpenClaw com a tabela local.
   * Cria/atualiza registros na tabela agentes baseado nos agentes do OpenClaw.
   * Retorna estatísticas da sincronização (criados, atualizados, total).
   */
  async sincronizarAgentesOpenClaw(): Promise<{ criados: number; atualizados: number; total: number }> {
    const agentesOpenClaw = await this.listarAgentesConsole();
    const db = await this.dbDoMotor();
    const { agentes } = await import('../schema');

    // Busca agentes existentes no banco
    const agentesExistentes = await db.select().from(agentes);
    const mapaExistentes = new Map(agentesExistentes.map(a => [a.nome, a]));

    let criados = 0;
    let atualizados = 0;

    for (const agenteOpenClaw of agentesOpenClaw) {
      const existente = mapaExistentes.get(agenteOpenClaw.id);
      if (!existente) {
        // Cria novo agente
        await db.insert(agentes).values({
          nome: agenteOpenClaw.id,
          modelo: agenteOpenClaw.model || 'unknown',
          descricao: agenteOpenClaw.name !== agenteOpenClaw.id ? agenteOpenClaw.name : null,
          ativo: true,
        });
        criados++;
      } else {
        // Atualiza agente existente (modelo e descrição)
        await db.update(agentes)
          .set({
            modelo: agenteOpenClaw.model || existente.modelo,
            descricao: agenteOpenClaw.name !== agenteOpenClaw.id ? agenteOpenClaw.name : existente.descricao,
          })
          .where(eq(agentes.id, existente.id));
        atualizados++;
      }
    }

    this.logger.log(`Sincronização de agentes: ${criados} criados, ${atualizados} atualizados, ${agentesOpenClaw.length} total`);
    return { criados, atualizados, total: agentesOpenClaw.length };
  }

  /**
   * Cria ou atualiza agente local baseado no ID do OpenClaw.
   * Chamado pelo motor quando cria um novo agente no OpenClaw.
   */
  async criarOuAtualizarAgenteLocal(openclawAgentId: string, modelo?: string): Promise<void> {
    const db = await this.dbDoMotor();
    const { agentes } = await import('../schema');

    const existente = await db.select().from(agentes).where(eq(agentes.nome, openclawAgentId)).limit(1);
    if (existente.length === 0) {
      await db.insert(agentes).values({
        nome: openclawAgentId,
        modelo: modelo || 'unknown',
        ativo: true,
      });
      this.logger.log(`Agente local criado: ${openclawAgentId}`);
    } else {
      const agenteExistente = existente[0];
      if (!agenteExistente) return;
      await db.update(agentes)
        .set({ modelo: modelo || agenteExistente.modelo })
        .where(eq(agentes.id, agenteExistente.id));
      this.logger.log(`Agente local atualizado: ${openclawAgentId}`);
    }
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    return await this.factory.obter({ id: projeto.id });
  }

  /**
   * Banco do motor (projeto_640 — GerenteAgentes).
   * O motor-v2 busca tarefas diretamente em projeto_640.tarefas (hardcoded).
   * Para manter consistência, todas as operações do motor (tarefas, subtarefas,
   * chats) devem usar este banco, independente do projetoId do token.
   */
  private async dbDoMotor() {
    return await this.factory.obter({ id: 640 });
  }

  private catalogEntry(chave: string) {
    const entry = AGENT_PROMPT_CATALOG.find((item) => item.key === chave);
    if (!entry) throw new BadRequestException(`Prompt desconhecido: ${chave}`);
    return entry;
  }

  /** Sincroniza metadados canônicos sem sobrescrever textos editados. */
  private async sincronizarCatalogoPrompts() {
    const db = await this.dbDoMotor();
    for (const entry of AGENT_PROMPT_CATALOG) {
      const existing = await db.select().from(promptsAgentes).where(eq(promptsAgentes.chave, entry.key)).limit(1);
      if (existing.length === 0) {
        const inserted = await db.insert(promptsAgentes).values({
          chave: entry.key,
          tipoAgente: entry.agentType,
          situacao: entry.situation,
          titulo: entry.key,
          descricao: `Compositor embarcado: ${entry.source}`,
          status: 'draft',
        });
        if (entry.prompt.trim()) {
          await db.insert(promptsVersoes).values({
            promptId: Number(inserted[0].insertId), versao: 1, texto: entry.prompt,
            motivo: 'Versão inicial do catálogo embarcado', autor: 'sistema',
            validacao: validatePromptTemplate(entry.prompt, entry.markers),
          });
        }
      }
      for (const marker of entry.markers) {
        const found = await db.select().from(promptsMascaras).where(eq(promptsMascaras.nome, marker)).limit(1);
        if (found.length === 0) {
          await db.insert(promptsMascaras).values({
            nome: marker,
            descricao: `Valor dinâmico utilizado por ${entry.key}`,
            origem: entry.source,
            obrigatoria: false,
          });
        }
      }
    }
  }

  async listarPrompts() {
    await this.sincronizarCatalogoPrompts();
    const db = await this.dbDoMotor();
    const prompts = await db.select().from(promptsAgentes).orderBy(promptsAgentes.tipoAgente, promptsAgentes.situacao);
    const masks = await db.select().from(promptsMascaras).where(eq(promptsMascaras.ativa, true)).orderBy(promptsMascaras.nome);
    const versions = await db.select().from(promptsVersoes).orderBy(desc(promptsVersoes.createdAt));
    return {
      prompts: prompts.map((prompt) => ({
        ...prompt,
        allowedMarkers: this.catalogEntry(prompt.chave).markers,
        versions: versions.filter((version) => version.promptId === prompt.id),
      })),
      masks,
    };
  }

  async salvarRascunhoPrompt(id: number, texto: string, motivo: string | undefined, autor: string | undefined) {
    const db = await this.dbDoMotor();
    const [prompt] = await db.select().from(promptsAgentes).where(eq(promptsAgentes.id, id)).limit(1);
    if (!prompt) throw new NotFoundException('Prompt não encontrado');
    const entry = this.catalogEntry(prompt.chave);
    const validation = validatePromptTemplate(texto, entry.markers);
    if (!validation.ok) throw new BadRequestException({ message: 'Máscaras inválidas', validation });
    const previous = await db.select().from(promptsVersoes).where(eq(promptsVersoes.promptId, id)).orderBy(desc(promptsVersoes.versao)).limit(1);
    const versao = (previous[0]?.versao ?? 0) + 1;
    const result = await db.insert(promptsVersoes).values({ promptId: id, versao, texto, motivo, autor, validacao: validation });
    await db.update(promptsAgentes).set({ status: prompt.versaoAtivaId ? 'active' : 'draft' }).where(eq(promptsAgentes.id, id));
    return { id: Number(result[0].insertId), versao, validation };
  }

  async publicarVersaoPrompt(promptId: number, versionId: number) {
    const db = await this.dbDoMotor();
    const [version] = await db.select().from(promptsVersoes).where(and(eq(promptsVersoes.id, versionId), eq(promptsVersoes.promptId, promptId))).limit(1);
    if (!version) throw new NotFoundException('Versão não encontrada para este prompt');
    const [prompt] = await db.select().from(promptsAgentes).where(eq(promptsAgentes.id, promptId)).limit(1);
    if (!prompt) throw new NotFoundException('Prompt não encontrado');
    const validation = validatePromptTemplate(version.texto, this.catalogEntry(prompt.chave).markers);
    if (!validation.ok) throw new BadRequestException({ message: 'Versão inválida', validation });
    await db.update(promptsAgentes).set({ versaoAtivaId: versionId, status: 'active' }).where(eq(promptsAgentes.id, promptId));
    return { ok: true, promptId, versionId };
  }

  async preverPrompt(id: number, texto: string, values: Record<string, unknown>) {
    const db = await this.dbDoMotor();
    const [prompt] = await db.select().from(promptsAgentes).where(eq(promptsAgentes.id, id)).limit(1);
    if (!prompt) throw new NotFoundException('Prompt não encontrado');
    const entry = this.catalogEntry(prompt.chave);
    const validation = validatePromptTemplate(texto, entry.markers);
    if (!validation.ok) return { validation, rendered: null };
    const completeValues = Object.fromEntries(entry.markers.map((marker) => [marker, values[marker] ?? `<${marker.slice(2, -2)}>`]));
    return { validation, rendered: renderPromptTemplate(texto, completeValues), used: markersIn(texto) };
  }

  /**
   * Faz requisição HTTP para o motor de tarefas (GerenteAgentes).
   */
  private motorRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    baseUrl?: string,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    // baseUrl explícito (ex.: motor-v2 local) ignora o Host header de proxy.
    const base = baseUrl ?? this.motorUrl;
    const url = new URL(`${base}${path}`);
    const isHttps = url.protocol === 'https:';
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(!baseUrl && this.motorHostHeader ? { Host: this.motorHostHeader } : {}),
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

  /**
   * Notifica o motor-v2 de que a resposta de clarificação chegou (a mensagem
   * já foi gravada no chat da tarefa aqui). O motor devolve a tarefa para
   * `planned` e reexecuta a análise com o histórico de perguntas/respostas.
   * Com MOTOR_VERSION v1 o fluxo de clarificação não existe — ignora.
   */
  private async encaminharRespostaClarificacao(
    tarefa: { id: number; externalId?: string | null },
    texto: string,
  ): Promise<void> {
    if (this.motorVersao !== 'v2') return;
    const motorId = tarefa.externalId || String(tarefa.id);
    const resp = await this.motorRequest(
      'POST',
      `/api/motor/task/${encodeURIComponent(motorId)}/clarification`,
      { texto, jaPersistida: true },
      this.motorV2Url,
    );
    if (!resp.ok) {
      throw new BadRequestException(
        `Mensagem salva, mas o motor não retomou a análise (${resp.status}): ${resp.body.slice(0, 200)}`,
      );
    }
  }

  async iniciarTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoMotor();
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.id, tarefaId))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    // Permite reiniciar tarefas bloqueadas/falhas/pausadas (não apenas draft/planned)
    const statusPermitidos = [...TASK_STATUS_STARTABLE];
    if (!statusPermitidos.includes(tarefa.status)) {
      throw new BadRequestException(`Tarefa não pode ser iniciada (status: ${tarefa.status})`);
    }

    // ── Ponte com o motor de execução ────────────────────────────────────────
    // A tarefa já existe no motor com o external_id. Chama apenas o endpoint
    // de enfileirar — o motor enfileira (FIFO) e executa.
    // v1: POST /api/task/:id/start · v2: POST /api/motor/task/:id/enqueue.
    const motorId = tarefa.externalId || `task-biblioteca-${tarefa.id}`;
    const usarV2 = this.motorVersao === 'v2';
    const startPath = usarV2
      ? `/api/motor/task/${encodeURIComponent(motorId)}/enqueue`
      : `/api/task/${encodeURIComponent(motorId)}/start`;
    const start = await this.motorRequest('POST', startPath, undefined, usarV2 ? this.motorV2Url : undefined).catch((e: unknown) => {
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
    const db = await this.dbDoMotor();
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

    if (this.motorVersao === 'v2') {
      const motorId = tarefa.externalId || String(tarefa.id);
      const resp = await this.motorRequest(
        'POST',
        `/api/motor/task/${encodeURIComponent(motorId)}/pause`,
        undefined,
        this.motorV2Url,
      ).catch((e: unknown) => {
        throw new BadRequestException(`Motor indisponível ao pausar a tarefa: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!resp.ok) {
        throw new BadRequestException(`Motor rejeitou a pausa (${resp.status}): ${resp.body.slice(0, 200)}`);
      }
    }

    await db
      .update(tarefas)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(tarefas.id, tarefaId));

    return { id: tarefaId, status: 'paused', message: 'Tarefa pausada' };
  }

  async retomarTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoMotor();
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

    if (this.motorVersao === 'v2') {
      const motorId = tarefa.externalId || String(tarefa.id);
      const resp = await this.motorRequest(
        'POST',
        `/api/motor/task/${encodeURIComponent(motorId)}/resume`,
        undefined,
        this.motorV2Url,
      ).catch((e: unknown) => {
        throw new BadRequestException(`Motor indisponível ao retomar a tarefa: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!resp.ok) {
        throw new BadRequestException(`Motor rejeitou a retomada (${resp.status}): ${resp.body.slice(0, 200)}`);
      }
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
    const db = await this.dbDoMotor();
    
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
    const db = await this.dbDoMotor();
    
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

    // Clarificação interativa: se a tarefa está aguardando esclarecimento e a
    // mensagem é uma resposta (role user), notifica o motor para gravar a
    // retomada da análise com o histórico. A mensagem já foi persistida aqui.
    if (role === 'user' && tarefa.status === 'awaiting_clarification') {
      await this.encaminharRespostaClarificacao(tarefa, texto);
    }

    const createdAt = new Date();
    this.realtime?.publicar({
      eventId: randomUUID(),
      occurredAt: createdAt.toISOString(),
      source: 'gerenteagentes.chat',
      projectId: Number(tarefa.projetoId),
      taskId: tarefaId,
      type: 'task.chat.message.created',
      payload: {
        id: mensagem.id,
        tarefaId,
        role,
        texto,
        createdAt: createdAt.toISOString(),
      },
    });

    return { id: mensagem.id, tarefaId, role, texto, createdAt };
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

    // Clarificação interativa por projeto: resposta do dono/agente devolve a
    // geração mais recente para `pending`, de onde o fluxo de geração retoma.
    if (role === 'user') {
      const [geracao] = await db
        .select()
        .from(geracoesProjeto)
        .where(eq(geracoesProjeto.projetoId, projetoCaptadoId))
        .orderBy(desc(geracoesProjeto.createdAt))
        .limit(1);
      if (geracao && geracao.status === 'awaiting_clarification') {
        await db
          .update(geracoesProjeto)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(eq(geracoesProjeto.id, geracao.id));
      }
    }

    return { id: mensagem.id, projetoId: projetoCaptadoId, role, texto, createdAt: new Date() };
  }

  /**
   * Clarificação interativa por projeto: registra as perguntas do analista no
   * chat do projeto e marca a geração mais recente como
   * `awaiting_clarification`. Quando a resposta chegar via chat (role user),
   * a geração volta para `pending` (ver adicionarMensagemChatProjeto).
   */
  async registrarClarificacaoProjeto(
    projeto: ProjetoResumo,
    projetoCaptadoId: number,
    resumo: string,
    perguntas: string[],
  ) {
    const db = await this.dbDoProjeto(projeto);

    const [projetoCaptado] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoCaptadoId))
      .limit(1);

    if (!projetoCaptado) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const [geracao] = await db
      .select()
      .from(geracoesProjeto)
      .where(eq(geracoesProjeto.projetoId, projetoCaptadoId))
      .orderBy(desc(geracoesProjeto.createdAt))
      .limit(1);

    if (!geracao) {
      throw new NotFoundException('Nenhuma geração em andamento para este projeto');
    }

    const limpas = perguntas.map((p) => String(p).trim()).filter(Boolean);
    if (limpas.length === 0) {
      throw new BadRequestException('Lista de perguntas vazia');
    }

    const linhas: string[] = ['🤔 O analista precisa de esclarecimentos antes de gerar as tarefas.', ''];
    if (resumo && resumo.trim()) {
      linhas.push('Entendimento atual: ' + resumo.trim(), '');
    }
    limpas.forEach((pergunta, indice) => linhas.push(`${indice + 1}) ${pergunta}`));
    linhas.push('', 'Responda neste chat para continuar (ex.: "1: resposta; 2: resposta").');

    await db.insert(projetoChats).values({
      projetoId: projetoCaptadoId,
      role: 'analyst',
      texto: linhas.join('\n'),
      createdAt: new Date(),
    });

    await db
      .update(geracoesProjeto)
      .set({ status: 'awaiting_clarification', updatedAt: new Date() })
      .where(eq(geracoesProjeto.id, geracao.id));

    return { ok: true, geracaoId: geracao.id, status: 'awaiting_clarification', perguntas: limpas };
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
    const db = await this.dbDoMotor();
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
      const resp = await this.motorRequest(
        'GET',
        `/api/motor/task/${encodeURIComponent(motorId)}`,
        undefined,
        this.motorVersao === 'v2' ? this.motorV2Url : undefined,
      );
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
        errorMessage?: string;
        subtasks?: Array<{
          seq?: number;
          deliveryHistory?: Array<{
            id: number;
            deliverNumber: number;
            model: string | null;
            eventType: string;
            reason: string | null;
            createdAt: string;
          }>;
        }>;
        ultimoBloqueio?: {
          kind?: string;
          excerpt?: string;
          blockedAt?: string;
          subtaskId?: number | null;
        } | null;
      };
      
      // Busca subtarefas do banco de dados (mesma tabela projeto_640.subtarefas
      // que o motor usa; mantém IDs reais para edição na tela)
      const subtarefasList = await db
        .select({
          id: subtarefas.id,
          seq: subtarefas.seq,
          titulo: subtarefas.titulo,
          status: subtarefas.status,
          deliverCount: subtarefas.deliverCount,
          resultado: subtarefas.resultado,
          scope: subtarefas.scope,
          acceptanceCriteria: subtarefas.acceptanceCriteria,
          workspaceStatus: subtarefas.workspaceStatus,
          correctionForSubtaskId: subtarefas.correctionForSubtaskId,
        })
        .from(subtarefas)
        .where(eq(subtarefas.tarefaId, tarefaId))
        .orderBy(subtarefas.seq);
      
      // Monta mapa de deliveryHistory vindo do motor (pass-through por seq)
      const motorHistoryBySeq = new Map<number, Array<{
        id: number;
        deliverNumber: number;
        model: string | null;
        eventType: string;
        reason: string | null;
        createdAt: string;
      }>>();
      for (const ms of motorTask.subtasks ?? []) {
        if (ms.seq != null && Array.isArray(ms.deliveryHistory)) {
          motorHistoryBySeq.set(ms.seq, ms.deliveryHistory);
        }
      }

      // Converte para o formato esperado pelo front-end
      const subtasks = subtarefasList.map(s => ({
        seq: s.seq,
        title: s.titulo,
        status: s.status,
        deliverCount: s.deliverCount,
        blockInfo: s.resultado ? { reason: s.resultado } : null,
        scope: s.scope ?? null,
        acceptanceCriteria: s.acceptanceCriteria ?? null,
        workspaceStatus: s.workspaceStatus ?? null,
        correctionForSubtaskId: s.correctionForSubtaskId ?? null,
        deliveryHistory: motorHistoryBySeq.get(s.seq) ?? [],
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
          errorMessage: motorTask.errorMessage ?? undefined,
          blockInfo: motorTask.ultimoBloqueio ?? null,
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
    const db = await this.dbDoMotor();
    
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
    emailUsuarioLogado: string,
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

    // Email do CLIENTE (contato da captação) — dono do projeto na plataforma.
    // Fallback: email do usuário logado (projeto criado manualmente sem contato).
    let emailCliente = emailUsuarioLogado;
    let nomeCliente: string | undefined;
    if (projetoCaptado.contatoId) {
      const [contato] = await db
        .select()
        .from(contatos)
        .where(eq(contatos.id, projetoCaptado.contatoId))
        .limit(1);
      if (contato?.email) {
        emailCliente = contato.email;
        nomeCliente = contato.nome ?? undefined;
      }
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
    // (cliente dono + dono da plataforma como admin em todos os projetos)
    const ownerUserId = Number(this.configService.get<string>('PLATAFORMA_OWNER_USER_ID') ?? '1')
    const provisionResult = await this.provisionService.provisionProject({
      email: emailCliente,
      nome: nomeCliente,
      projetoNome: projetoCaptado.nome,
      projetoSlug: projetoCaptado.slug,
      extraAdminUserIds: Number.isInteger(ownerUserId) && ownerUserId > 0 ? [ownerUserId] : [],
    });

    // Atualizar o projeto_captado com o plataformaProjetoId
    await db
      .update(projetosCaptados)
      .set({
        plataformaProjetoId: provisionResult.projetoId,
        updatedAt: new Date(),
      })
      .where(eq(projetosCaptados.id, projetoCaptadoId));

    // Disparar a missão de setup no agente biblioteca-global (idempotente).
    const missao = await this.dispararMissaoSetup(db, projetoCaptado, provisionResult.projetoId);

    return {
      projetoId: projetoCaptado.id,
      plataformaProjetoId: provisionResult.projetoId,
      usuarioId: provisionResult.usuarioId,
      perfil: provisionResult.perfil,
      criado: provisionResult.criado,
      ...(missao ? { missao } : {}),
      message: 'Desenvolvimento iniciado - projeto provisionado na plataforma',
    };
  }

  /**
   * Cria e enfileira a tarefa de setup do projeto no agente biblioteca-global.
   * A missão roda no monorepo: pasta do projeto, config.ts, banco, schema,
   * migration, push — e o gate de agente dedicado para telas além do CRUD.
   * Idempotente por externalId.
   */
  private async dispararMissaoSetup(
    db: Awaited<ReturnType<GerenteAgentesService['dbDoProjeto']>>,
    projetoCaptado: typeof projetosCaptados.$inferSelect,
    plataformaProjetoId: number,
  ): Promise<{ tarefaId: number; motorId: string; nova: boolean } | null> {
    // Projeto executor: o próprio biblioteca-global (monorepo).
    const [executor] = await db
      .select()
      .from(projetosCaptados)
      .where(eq(projetosCaptados.slug, 'biblioteca-global'))
      .limit(1);

    if (!executor) {
      this.logger.warn('Projeto executor biblioteca-global não encontrado — missão de setup não disparada');
      return null;
    }

    const motorId = `setup-${projetoCaptado.slug}`;

    // Idempotência: missão já criada anteriormente.
    const [existente] = await db
      .select()
      .from(tarefas)
      .where(eq(tarefas.externalId, motorId))
      .limit(1);

    let tarefaId: number;
    let nova = false;

    if (existente) {
      tarefaId = existente.id;
    } else {
      const descricao = this.montarMissaoSetup(projetoCaptado, plataformaProjetoId);
      const [inserida] = await db
        .insert(tarefas)
        .values({
          externalId: motorId,
          projetoId: executor.id,
          titulo: `Setup do projeto: ${projetoCaptado.nome}`,
          descricao,
          status: 'planned',
        })
        .$returningId();
      if (!inserida) {
        this.logger.warn('Falha ao inserir tarefa de setup — missão não disparada');
        return null;
      }
      tarefaId = inserida.id;
      nova = true;
    }

    // Enfileira no motor (v2: /api/motor/task/:id/enqueue).
    const usarV2 = this.motorVersao === 'v2';
    const enqueuePath = usarV2
      ? `/api/motor/task/${encodeURIComponent(motorId)}/enqueue`
      : `/api/task/${encodeURIComponent(motorId)}/start`;
    const resp = await this
      .motorRequest('POST', enqueuePath, undefined, usarV2 ? this.motorV2Url : undefined)
      .catch((e: unknown) => {
        this.logger.warn(`Motor indisponível ao enfileirar setup: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

    if (resp && !resp.ok) {
      this.logger.warn(`Motor rejeitou o setup (${resp.status}): ${resp.body.slice(0, 200)}`);
    }

    return { tarefaId, motorId, nova };
  }

  /** Texto da missão de setup entregue ao agente biblioteca-global. */
  private montarMissaoSetup(
    projetoCaptado: typeof projetosCaptados.$inferSelect,
    plataformaProjetoId: number,
  ): string {
    const slug = projetoCaptado.slug;
    const linhas = [
      `MISSÃO — Setup do projeto "${projetoCaptado.nome}" (slug: ${slug})`,
      '',
      'O projeto já foi provisionado na plataforma: core.projetos criado e usuários',
      `(cliente e dono da plataforma) vinculados como admin. plataformaProjetoId = ${plataformaProjetoId}.`,
      '',
      'Descrição do projeto (redigida pela Isa na captação):',
      '---',
      projetoCaptado.descricao ?? '(sem descrição)',
      '---',
      '',
      'Execute os passos abaixo, nesta ordem:',
      '',
      '=== PASSO 1: ESTRUTURA DO PROJETO ===',
      `1.1. Crie a pasta do projeto em projects/${slug} neste monorepo.`,
      '1.2. Crie o config.ts do projeto com menus, telas e campos, seguindo',
      '     docs/MANUAL_CONFIG_PROJETOS.md e a descrição acima.',
      '1.3. Crie o schema.ts com as tabelas necessárias.',
      `1.4. Crie o banco projeto_${plataformaProjetoId} (convenção projeto_<id do core>).`,
      '1.5. Execute as migrations.',
      '',
      '=== PASSO 2: CHECKLIST DE REGISTROS OBRIGATÓRIOS ===',
      '',
      'Enquanto a plataforma não tiver autodescoberta automática de projetos,',
      'CADA registro abaixo é OBRIGATÓRIO para o projeto funcionar. O gate do',
      'motor vai validar a presença de cada um antes de declarar setup concluído.',
      '',
      '2.1. SCHEMA-REGISTRY DA API (backend):',
      '     Arquivo: apps/api/src/modules/crud/schema-registry.ts',
      `     - Importar o schema: import * as ${slug.replace(/-/g, '')}Schema from "../../../../../projects/${slug}/schema"`,
      `     - Adicionar no Map: ["${slug}", coletarTabelas(${slug.replace(/-/g, '')}Schema)]`,
      '',
      '2.2. REGISTRY DO FRONT (config):',
      '     Arquivo: apps/web/src/project/registry/projects.ts',
      `     - Importar a config: import { config as ${slug.replace(/-/g, '')}Config } from "../../../../../projects/${slug}/config"`,
      `     - Adicionar no projectConfigs: "${slug}": ${slug.replace(/-/g, '')}Config`,
      '',
      '2.3. TELAS CUSTOM DO FRONT (se houver telas com kind: "custom"):',
      '     Arquivo: apps/web/src/project/registry/customScreens.tsx',
      `     - Importar cada tela de projects/${slug}/screens/`,
      '     - Registrar em registrarTelasCustom() com o MESMO componentId do config.ts',
      '     ⚠️  componentId no config.ts DEVE BATER com o id registrado no registry',
      '',
      '2.4. SEED DO BANCO (se o projeto precisa de dados iniciais):',
      '     Arquivo: database/seed.ts (ou projects/${slug}/seed-*.ts)',
      '     - Inserir registros iniciais necessários para o projeto funcionar',
      '     - Exemplo: projetos/gerenteagentes/seed-agentes.ts',
      '',
      '2.5. DOCKERFILES (COPY dos package.json):',
      '     Arquivo: apps/api/Dockerfile',
      `     - Adicionar: COPY projects/${slug}/package.json projects/${slug}/package.json`,
      '     Arquivo: apps/web/Dockerfile (se existir)',
      `     - Adicionar COPY equivalente para o front`,
      '',
      '2.6. LOCKFILE DA RAIZ:',
      '     Arquivo: package-lock.json (na raiz do monorepo)',
      '     - Executar "npm install" na raiz para atualizar o lockfile',
      '     - O lockfile DEVE estar commitado (npm ci depende dele no Docker)',
      '',
      '2.7. PROJECT-DB.FACTORY (se o projeto tem banco próprio):',
      '     Arquivo: apps/api/src/modules/crud/project-db.factory.ts',
      '     - Verificar se o projeto está mapeado (geralmente automático via core.projetos)',
      '',
      '=== PASSO 3: GATE DE AGENTE DEDICADO ===',
      '',
      'Analise o config.ts: o projeto tem telas ALÉM do CRUD (kind: "custom")?',
      '   - SE SIM:',
      `     3.1. Crie o agente do projeto no OpenClaw com id = "${slug}" e workspace`,
      `          /data/workspace/projects/agentes/${slug} (pasta com AGENTS.md, SOUL.md,`,
      '          IDENTITY.md, USER.md, TOOLS.md);',
      '',
      '     3.2. REGISTRO NO GATEWAY (OBRIGATÓRIO — sem isso o motor não encontra o agente):',
      `          Execute o comando CLI para registrar o agente no gateway:`,
      `          openclaw agents add ${slug} --workspace /data/workspace/projects/agentes/${slug} --model <modelo> --non-interactive`,
      '          Onde <modelo> é o modelo configurado para o agente (ex.: ollama/qwen3-coder:30b).',
      '          Verifique o registro com: openclaw agents list',
      '',
      '     3.3. Delegue a configuração dos arquivos de personalidade ao agente',
      '          definicaopersonalidadeagentes (Forjador), passando a descrição do',
      '          projeto, e AGUARDE ele terminar;',
      '',
      '     3.4. Registre o agente na tabela projeto_640.agentes (espelho do OpenClaw):',
      `          nome, modelo e openclaw_agent_id = "${slug}" (o motor resolve o agente por`,
      '          COALESCE(openclaw_agent_id, nome));',
      '',
      '     3.5. Vincule o projeto ao agente: UPDATE projeto_640.projetos_captados SET',
      `          agente_id = <id da linha de agentes> WHERE slug = "${slug}" — é esse vínculo`,
      '          que faz o motor executar as tarefas do projeto com o agente novo;',
      '',
      '     3.6. TELAS PERSONALIZADAS COMO TAREFAS DO PROJETO (NÃO subtarefas do setup):',
      '          Para cada funcionalidade NÃO compatível com o CRUD da biblioteca,',
      '          crie UMA TAREFA (não subtarefa) no motor ligada ao projeto novo:',
      '          - tarefas.projeto_id = id de projetos_captados do projeto novo',
      '          - tarefas.auto_start = true (execução automática em sequência)',
      '          - O agente que executa essas tarefas é o agente do projeto novo',
      '            (não o biblioteca-global que fez o setup)',
      '          - Exemplo: se o projeto tem uma tela custom de dashboard, crie a',
      '            tarefa "Implementar tela Dashboard" vinculada ao projeto',
      '',
      '   - SE NÃO (só CRUD): nenhum agente dedicado é criado.',
      '',
      '=== PASSO 4: SMOKE TEST FUNCIONAL (OBRIGATÓRIO) ===',
      '',
      'A última subtarefa do setup DEVE ser o smoke test funcional. O motor',
      'reprova o setup sem evidência de que o projeto novo responde via HTTP.',
      '',
      '4.1. Execute uma chamada HTTP real (curl) a um endpoint CRUD do projeto',
      `     novo. Exemplo: curl -s http://localhost:3000/api/${slug}/`,
      '     (use a porta e o slug corretos do projeto).',
      '',
      '4.2. A resposta DEVE ser 2xx (sucesso). Se retornar 404/500/timeout,',
      '     o smoke test FALHA e o setup não pode ser concluído.',
      '',
      '4.3. Grave a evidência no resultado da subtarefa em formato JSON:',
      '     {"smoke_test":{"url":"http://...","method":"GET","status":200,',
      '      "response_body":"...","timestamp":"2026-..."}}',
      '',
      '     O gate do motor VALIDA essa evidência antes de marcar como verified.',
      '     Sem ela, a subtarefa é rejeitada e o setup não fecha.',
      '',
      '=== PASSO 5: FINALIZAÇÃO ===',
      '',
      '5.1. Faça commit e push de TODAS as alterações.',
      '5.2. NÃO publique nada por projeto: apenas a própria biblioteca é publicada',
      '     (ela já seleciona o projeto do usuário logado).',
      '5.3. Registre no resultado:',
      '     - Lista de todos os registros criados (schema-registry, front registry,',
      '       seed, Dockerfiles, lockfile, agente no gateway)',
      '     - Lista de tarefas criadas para telas personalizadas (se houver)',
      '     - Qualquer bloqueio ou pendência',
      '',
      '⚠️  O gate do motor vai verificar cada item do checklist antes de aceitar',
      '    a tarefa como concluída. Itens faltantes = tarefa bloqueada.',
    ];
    return linhas.join('\n');
  }
}

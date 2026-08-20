import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, desc } from 'drizzle-orm';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProjetoResumo } from '@biblioteca-global/shared';
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from '../crud/project-db.factory';
import { SCHEMA_REGISTRY, type SchemaRegistry } from '../crud/schema-registry';
import {
  agentes,
  tarefas,
  subtarefas,
  tarefaChats,
  projetoChats,
  projetosCaptados,
  geracoesProjeto,
} from '../../../../../projects/gerenteagentes/schema';
import { ProvisionService } from '../provision/provision.service';

@Injectable()
export class GerenteAgentesService {
  private readonly motorUrl: string;
  private readonly motorHostHeader: string;

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
    @Inject(ProvisionService) private readonly provisionService: ProvisionService,
    private readonly configService: ConfigService,
  ) {
    // Motor de execução (rodando no container openclaw:6283, exposto via proxy NPM)
    this.motorUrl = this.configService.get<string>('MOTOR_DEV_URL') || 'http://192.168.1.16';
    this.motorHostHeader = this.configService.get<string>('MOTOR_URL_HOST') || 'api.tarefas.localhost';
  }

  /**
   * HTTP request para o motor (via proxy NPM com Host header quando configurado).
   */
  private motorRequest(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.motorUrl}${path}`);
      const isHttps = url.protocol === 'https:';
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const options: RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(this.motorHostHeader ? { Host: this.motorHostHeader } : {}),
        },
        timeout: 10000,
      };
      const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode ?? 0,
            body: data,
          }),
        );
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    return await this.factory.obter({ id: projeto.id });
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

    if (tarefa.status !== 'draft' && tarefa.status !== 'planned') {
      throw new BadRequestException(`Tarefa não pode ser iniciada (status: ${tarefa.status})`);
    }

    // ── Ponte com o motor de execução ────────────────────────────────────────
    // 1) Garante a task no motor (id determinística task-biblioteca-<id>).
    // 2) Chama POST /api/task/:id/start — o motor enfileira (FIFO) e executa,
    //    criando e processando subtarefas até a conclusão.
    const [agente] = await db.select().from(agentes).where(eq(agentes.id, tarefa.agenteId)).limit(1);
    const motorId = `task-biblioteca-${tarefa.id}`;
    const motorBody = {
      id: motorId,
      agentId: agente?.nome ?? 'programador-senior',
      title: tarefa.titulo,
      description: tarefa.descricao ?? '',
      repoPath: tarefa.repoPath ?? '',
      buildCommand: tarefa.buildCommand ?? 'npm run build',
      unitTestCommand: tarefa.unitTestCommand ?? 'npm run test',
    };
    const criar = await this.motorRequest('POST', '/api/tasks', motorBody).catch((e) => {
      throw new BadRequestException(`Motor indisponível ao criar a tarefa: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!criar.ok) {
      throw new BadRequestException(`Motor rejeitou a criação da tarefa (${criar.status}): ${criar.body.slice(0, 200)}`);
    }
    const start = await this.motorRequest('POST', `/api/task/${encodeURIComponent(motorId)}/start`).catch((e) => {
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
    const motorId = `task-biblioteca-${tarefa.id}`;
    try {
      const resp = await this.motorRequest('GET', `/api/task/${encodeURIComponent(motorId)}/detail`);
      if (resp.status === 404) {
        return { motorId, exists: false, message: 'Tarefa ainda não foi enviada ao motor (clique em Iniciar).' };
      }
      if (!resp.ok) {
        throw new BadRequestException(`Motor retornou ${resp.status}: ${resp.body.slice(0, 200)}`);
      }
      const data = JSON.parse(resp.body) as {
        task?: unknown;
        subtasks?: unknown[];
        currentSubTask?: unknown;
        events?: unknown[];
        errors?: unknown[];
        models?: unknown[];
      };
      return { motorId, exists: true, ...data };
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

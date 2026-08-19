import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import type { ProjetoResumo } from '@biblioteca-global/shared';
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from '../crud/project-db.factory';
import { SCHEMA_REGISTRY, type SchemaRegistry } from '../crud/schema-registry';
import {
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
  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
    @Inject(ProvisionService) private readonly provisionService: ProvisionService,
  ) {}

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
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.projetoId, projeto.id)))
      .limit(1);

    if (!tarefa) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    if (tarefa.status !== 'draft' && tarefa.status !== 'planned') {
      throw new BadRequestException(`Tarefa não pode ser iniciada (status: ${tarefa.status})`);
    }

    await db
      .update(tarefas)
      .set({ status: 'planned', updatedAt: new Date() })
      .where(eq(tarefas.id, tarefaId));

    return { id: tarefaId, status: 'planned', message: 'Tarefa iniciada' };
  }

  async pausarTarefa(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.projetoId, projeto.id)))
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
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.projetoId, projeto.id)))
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
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.projetoId, projeto.id)))
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
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.projetoId, projeto.id)))
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

  async listarSubtarefas(projeto: ProjetoResumo, tarefaId: number) {
    const db = await this.dbDoProjeto(projeto);
    
    // Verificar se a tarefa pertence ao projeto
    const [tarefa] = await db
      .select()
      .from(tarefas)
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.projetoId, projeto.id)))
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

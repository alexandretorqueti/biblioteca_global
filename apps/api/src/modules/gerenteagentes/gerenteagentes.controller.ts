import { Put } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ProjectScopeGuard } from '../../common/guards/project-scope.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentProject } from '../../common/decorators/current.decorator';
import { CurrentUser } from '../../common/decorators/current.decorator';
import type { ProjetoResumo, UsuarioAutenticado, ModelSelectionTipo } from '@biblioteca-global/shared';
import { ModelSelectionTipoSchema } from '@biblioteca-global/shared';
import { GerenteAgentesService } from './gerenteagentes.service';
import { TaskStatusPollerService } from './task-status-poller.service';

@Controller('gerenteagentes')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, RolesGuard)
export class GerenteAgentesController {
  constructor(
    @Inject(GerenteAgentesService) private readonly service: GerenteAgentesService,
    private readonly poller: TaskStatusPollerService,
  ) {}

  // ============================================================================
  // AÇÕES DE TAREFA
  // ============================================================================

  @Post('tarefas/:id/start')
  @Roles('admin', 'gerente', 'operador')
  iniciarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.iniciarTarefa(projeto, id);
  }

  @Post('tarefas/:id/pause')
  @Roles('admin', 'gerente', 'operador')
  pausarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.pausarTarefa(projeto, id);
  }

  @Post('tarefas/:id/resume')
  @Roles('admin', 'gerente', 'operador')
  retomarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.retomarTarefa(projeto, id);
  }

  // ============================================================================
  // CHAT DA TAREFA
  // ============================================================================

  @Get('tarefas/:id/chat')
  listarChatTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.listarChatTarefa(projeto, id);
  }

  @Post('tarefas/:id/chat')
  @Roles('admin', 'gerente', 'operador')
  adicionarMensagemChatTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { role: string; texto: string },
  ) {
    return this.service.adicionarMensagemChatTarefa(projeto, id, body.role, body.texto);
  }

  // ============================================================================
  // CHAT DO PROJETO
  // ============================================================================

  @Get('projetos-captados/:id/chat')
  listarChatProjeto(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.listarChatProjeto(projeto, id);
  }

  @Post('projetos-captados/:id/chat')
  @Roles('admin', 'gerente', 'operador')
  adicionarMensagemChatProjeto(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { role: string; texto: string },
  ) {
    return this.service.adicionarMensagemChatProjeto(projeto, id, body.role, body.texto);
  }

  // ============================================================================
  // GERAÇÃO MACRO (START DO PROJETO)
  // ============================================================================

  @Post('projetos-captados/:id/start')
  @Roles('admin', 'gerente', 'operador')
  iniciarGeracaoProjeto(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.iniciarGeracaoProjeto(projeto, id);
  }

  @Get('projetos-captados/:id/geracoes')
  listarGeracoesProjeto(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.listarGeracoesProjeto(projeto, id);
  }

  // ============================================================================
  // SUBTAREFAS
  // ============================================================================

  @Get('tarefas/:id/subtarefas')
  listarSubtarefas(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.listarSubtarefas(projeto, id);
  }

  @Get('tarefas/:id/motor-detail')
  motorDetailTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.motorDetailTarefa(projeto, id);
  }

  // ============================================================================
  // SELEÇÃO DE MODELOS (proxy p/ motor — task-54)
  // ============================================================================

  /** Valida o param `tipo` (DEV/ANALYST/MONITOR) — 400 se inválido. */
  private tipoOuErro(tipo: string): ModelSelectionTipo {
    const parsed = ModelSelectionTipoSchema.safeParse(tipo.toUpperCase());
    if (!parsed.success) {
      throw new BadRequestException(`Tipo inválido: '${tipo}' — esperado DEV, ANALYST ou MONITOR`);
    }
    return parsed.data;
  }

  @Get('model-selection/:projectKey/:tipo')
  getModelSelection(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('projectKey') _projectKey: string,
    @Param('tipo') tipo: string,
  ) {
    return this.service.getModelSelection(projeto, this.tipoOuErro(tipo));
  }

  @Put('model-selection/:projectKey/:tipo')
  @Roles('admin', 'gerente', 'operador')
  saveModelSelection(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('projectKey') _projectKey: string,
    @Param('tipo') tipo: string,
    @Body() body: { entries: unknown },
  ) {
    if (!body || !Array.isArray(body.entries)) {
      throw new BadRequestException('Body inválido — esperado { entries: [...] }');
    }
    return this.service.saveModelSelection(projeto, this.tipoOuErro(tipo), body.entries);
  }

  /**
   * Modelos disponíveis no Console OpenClaw (proxy — task-66): alimenta o
   * combo de escolha de modelos por projeto. Admin/gerente escolhem;
   * o console nunca é exposto ao browser.
   */
  @Get('modelos-console')
  @Roles('admin', 'gerente')
  listarModelosConsole() {
    return this.service.listarModelosConsole();
  }

  // ============================================================================
  // INICIAR DESENVOLVIMENTO (integração 1:1 com core)
  // ============================================================================

  @Post('projetos-captados/:id/desenvolvimento')
  @Roles('admin', 'gerente')
  iniciarDesenvolvimento(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
  ) {
    if (!usuario.email) {
      throw new BadRequestException('Usuário não tem email cadastrado');
    }
    return this.service.iniciarDesenvolvimento(projeto, id, usuario.email);
  }

  // ============================================================================
  // POLLING DE STATUS (Fase 2 — tempo real)
  // ============================================================================

  @Get('tasks/by-status')
  @Roles('admin', 'gerente', 'operador')
  getTasksByStatus(@CurrentProject() projeto: ProjetoResumo) {
    // Retorna o cache do poller (tarefas agrupadas por status)
    const tasks = this.poller.getTasksByStatus();
    const timestamp = this.poller.getLastTimestamp();
    return {
      tasks,
      timestamp,
      projetoId: projeto.id,
    };
  }
}

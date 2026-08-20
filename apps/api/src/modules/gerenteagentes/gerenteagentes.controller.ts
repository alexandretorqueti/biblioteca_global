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
import type { ProjetoResumo, UsuarioAutenticado } from '@biblioteca-global/shared';
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

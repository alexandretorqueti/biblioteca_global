import { Delete, Patch, Put } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../apps/api/src/common/guards/jwt-auth.guard';
import { ProjectScopeGuard } from '../../../apps/api/src/common/guards/project-scope.guard';
import { RolesGuard } from '../../../apps/api/src/common/guards/roles.guard';
import { Roles } from '../../../apps/api/src/common/decorators/roles.decorator';
import { CurrentProject } from '../../../apps/api/src/common/decorators/current.decorator';
import { CurrentUser } from '../../../apps/api/src/common/decorators/current.decorator';
import type { ProjetoResumo, UsuarioAutenticado, ModelSelectionTipo } from '@biblioteca-global/shared';
import { ModelSelectionTipoSchema } from '@biblioteca-global/shared';
import { GerenteAgentesService } from './gerenteagentes.service';
import { TaskStatusPollerService } from './task-status-poller.service';
import { GitInspectorService } from './git-inspector.service';

@Controller('gerenteagentes')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, RolesGuard)
export class GerenteAgentesController {
  constructor(
    @Inject(GerenteAgentesService) private readonly service: GerenteAgentesService,
    private readonly poller: TaskStatusPollerService,
    private readonly gitInspector: GitInspectorService,
  ) {}

  // ============================================================================
  // AÇÕES DE TAREFA
  // ============================================================================

  /**
   * Criação específica do domínio. `projeto_id` é o ID do projeto gerenciado
   * em projetos_captados, não o ID do projeto da plataforma presente no token.
   * Esta rota precede o CRUD genérico e evita misturar os dois namespaces.
   */
  @Post('tarefas')
  @Roles('admin', 'gerente', 'operador')
  criarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Body() body: {
      projeto_id?: number;
      managedProjectId?: number;
      titulo?: string;
      descricao?: string | null;
      tipo?: 'desenvolvimento' | 'automacao' | 'verificacao';
      status?: string;
      dependsOnTaskId?: number | null;
      autoStart?: boolean;
    },
    @CurrentUser() usuario?: UsuarioAutenticado,
  ) {
    return this.service.criarTarefa(projeto, {
      managedProjectId: body.managedProjectId ?? body.projeto_id,
      titulo: body.titulo,
      descricao: body.descricao,
      tipo: body.tipo,
      status: body.status,
      dependsOnTaskId: body.dependsOnTaskId,
      autoStart: body.autoStart,
      ator: usuario?.email || usuario?.username || String(usuario?.id ?? 'usuario'),
    });
  }

  /** Atualização usada pelo mapa para mover uma tarefa entre estações. */
  @Patch('tarefas/:id/status')
  @Roles('admin', 'gerente', 'operador')
  atualizarStatusTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status?: string },
  ) {
    return this.service.atualizarStatusTarefa(projeto, id, body?.status);
  }

  /** Lista tarefas com status calculado pelo motor (fatos operacionais). */
  @Get('tarefas-com-status')
  @Roles('admin', 'gerente', 'operador')
  listarTarefasComStatusCalculado(
    @CurrentProject() projeto: ProjetoResumo,
    @Query('projetoId') projetoId?: string,
    @Query('status') status?: string,
  ) {
    return this.service.listarTarefasComStatusCalculado(projeto, {
      projetoId: projetoId ? Number(projetoId) : undefined,
      status,
    });
  }

  @Post('tarefas/:id/start')
  @Roles('admin', 'gerente', 'operador')
  iniciarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.iniciarTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id));
  }

  @Post('tarefas/:id/pause')
  @Roles('admin', 'gerente', 'operador')
  pausarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.pausarTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id));
  }

  @Post('tarefas/:id/resume')
  @Roles('admin', 'gerente', 'operador')
  retomarTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.retomarTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id));
  }

  @Post('tarefas/:id/cancel')
  @Roles('admin', 'gerente', 'operador')
  cancelarTarefa(@CurrentProject() projeto: ProjetoResumo, @CurrentUser() usuario: UsuarioAutenticado, @Param('id', ParseIntPipe) id: number, @Body() body: { motivo?: string }) {
    return this.service.cancelarTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id), body?.motivo);
  }

  @Delete('tarefas/:id')
  @Roles('admin', 'gerente')
  excluirTarefa(@CurrentProject() projeto: ProjetoResumo, @CurrentUser() usuario: UsuarioAutenticado, @Param('id', ParseIntPipe) id: number) {
    return this.service.excluirTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id));
  }

  @Get('tarefas/:id/eventos')
  @Roles('admin', 'gerente', 'operador')
  listarEventosTarefa(@CurrentProject() projeto: ProjetoResumo, @Param('id', ParseIntPipe) id: number) {
    return this.service.listarEventosTarefa(projeto, id);
  }

  /**
   * Bulk: pausa todas as tarefas não-finais e não-pausadas.
   * Pausa individual via motor; falhas não abortam o lote (Promise.allSettled).
   */
  @Post('tarefas/pause-all')
  @Roles('admin', 'gerente', 'operador')
  pausarTodasTarefas() {
    return this.service.pausarTodasTarefas();
  }

  /**
   * Bulk: retoma todas as tarefas pausadas (limpa pausedAt).
   * Tarefas não-pausadas são contadas como skipped.
   */
  @Post('tarefas/resume-all')
  @Roles('admin', 'gerente', 'operador')
  retomarTodasTarefas() {
    return this.service.retomarTodasTarefas();
  }

  @Post('tarefas/:id/unlock')
  @Roles('admin', 'gerente', 'operador')
  desbloquearTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.desbloquearTarefa(projeto, id);
  }

  @Post('tarefas/:id/sanitize-session')
  @Roles('admin', 'gerente', 'operador')
  sanearSessaoTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.sanearSessaoTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id));
  }

  @Post('tarefas/:id/deploy')
  @Roles('admin', 'gerente', 'operador')
  fazerDeployTarefa(@CurrentProject() projeto: ProjetoResumo, @CurrentUser() usuario: UsuarioAutenticado, @Param('id', ParseIntPipe) id: number) {
    return this.service.fazerDeployTarefa(projeto, id, usuario.email || usuario.username || String(usuario.id));
  }

  @Post('tarefas/:id/adjustment')
  @Roles('admin', 'gerente', 'operador')
  solicitarAjusteTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { message: string },
  ) {
    return this.service.solicitarAjusteTarefa(projeto, id, body?.message);
  }

  @Get('motor-activity')
  atividadeMotor(@CurrentProject() projeto: ProjetoResumo) {
    return this.service.atividadeMotor(projeto);
  }

  @Get('motor-v3/tabelas/:tabela')
  @Roles('admin', 'gerente', 'operador')
  listarTabelaMotorV3(@Param('tabela') tabela: string) {
    return this.service.listarTabelaMotorV3(tabela);
  }

  @Get('motor-deploy-diagnostics')
  diagnosticoDeploy(@CurrentProject() projeto: ProjetoResumo) {
    return this.service.diagnosticoDeploy(projeto);
  }

  @Get('test-runs')
  @Roles('admin', 'gerente', 'operador')
  listarHistoricoTestes(
    @CurrentProject() projeto: ProjetoResumo,
    @Query('projetoId') projetoId?: string,
    @Query('tarefaId') tarefaId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listarHistoricoTestes(projeto, {
      projetoId: projetoId ? Number(projetoId) : undefined,
      tarefaId: tarefaId ? Number(tarefaId) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
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
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { texto: string; modo?: 'normal' | 'solicitar_pausa' },
  ) {
    return this.service.adicionarMensagemChatTarefa(projeto, id, body.texto, body.modo, {
      id: String(usuario.id),
      nome: usuario.email || usuario.username || String(usuario.id),
    });
  }

  @Post('tarefas/:id/interacao/retomar')
  @Roles('admin', 'gerente', 'operador')
  retomarInteracaoTarefa(@CurrentProject() projeto: ProjetoResumo, @Param('id', ParseIntPipe) id: number) {
    return this.service.retomarInteracaoTarefa(projeto, id);
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

  /**
   * Clarificação interativa por projeto: o analista registra perguntas no
   * chat do projeto e a geração corrente fica `awaiting_clarification` até a
   * resposta chegar pelo próprio chat (POST .../chat com role user).
   */
  @Post('projetos-captados/:id/clarificacao')
  @Roles('admin', 'gerente', 'operador')
  registrarClarificacaoProjeto(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { resumo: string; perguntas: string[] },
  ) {
    return this.service.registrarClarificacaoProjeto(projeto, id, body.resumo, body.perguntas);
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

  @Get('tarefas/:id/subtarefas/:seq/sessao')
  visualizarSessaoSubtarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Param('seq', ParseIntPipe) seq: number,
    @Query('sessionKey') sessionKey?: string,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.sessaoSubtarefa(projeto, id, seq, {
      sessionKey,
      cursor,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('tarefas/:id/sessoes-analista')
  visualizarSessoesAnalistaTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Query('sessionKey') sessionKey?: string,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.sessoesAnalistaTarefa(projeto, id, {
      sessionKey,
      cursor,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('tarefas/:id/motor-detail')
  motorDetailTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.motorDetailTarefa(projeto, id);
  }

  @Get('tarefas/:id/operacoes-motor')
  @Roles('admin', 'gerente', 'operador')
  listarOperacoesMotorTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.listarOperacoesMotorTarefa(projeto, id);
  }

  // ============================================================================
  // AGENTES (sincronização com OpenClaw)
  // ============================================================================

  /**
   * Lista agentes do console OpenClaw (proxy server-side).
   * Retorna agentes registrados no OpenClaw para sincronização com a tabela local.
   */
  @Get('agentes/openclaw')
  @Roles('admin', 'gerente')
  listarAgentesOpenClaw() {
    return this.service.listarAgentesConsole();
  }

  /**
   * Sincroniza agentes do OpenClaw com a tabela local.
   * Cria/atualiza registros na tabela agentes baseado nos agentes do OpenClaw.
   */
  @Post('agentes/sincronizar')
  @Roles('admin', 'gerente')
  async sincronizarAgentes() {
    return this.service.sincronizarAgentesOpenClaw();
  }

  @Get('agentes/:id/vinculo')
  @Roles('admin', 'gerente')
  diagnosticarVinculoAgente(@Param('id', ParseIntPipe) id: number) {
    return this.service.diagnosticarVinculoAgente(id);
  }

  // ============================================================================
  // SELEÇÃO DE MODELOS (Biblioteca; consumida pelo Motor)
  // ============================================================================

  /** Valida o param `tipo` (DEV/ANALYST/MONITOR) — 400 se inválido. */
  private tipoOuErro(tipo: string): ModelSelectionTipo {
    const parsed = ModelSelectionTipoSchema.safeParse(tipo.toUpperCase());
    if (!parsed.success) {
      throw new BadRequestException(`Tipo inválido: '${tipo}' — esperado DEV, ANALYST ou MONITOR`);
    }
    return parsed.data;
  }

  /** Valida o param `projectKey` (slug do projeto captado) — 400 se vazio/malformado. */
  private projectKeyOuErro(projectKey: string): string {
    const chave = (projectKey ?? '').trim();
    if (chave.length === 0 || /[\s/]/.test(chave)) {
      throw new BadRequestException(`projectKey inválido: '${projectKey}'`);
    }
    return chave;
  }

  @Get('model-selection/:projectKey/:tipo')
  getModelSelection(
    @Param('projectKey') projectKey: string,
    @Param('tipo') tipo: string,
  ) {
    return this.service.getModelSelection(this.projectKeyOuErro(projectKey), this.tipoOuErro(tipo));
  }

  /** Configuração global, administrada pela tela CONFIGURAÇÕES. */
  @Get('model-selection/global')
  @Roles('admin', 'gerente')
  getGlobalModelSelection() {
    return this.service.getGlobalModelSelection();
  }

  // ============================================================================
  // CONFIGURAÇÕES OPERACIONAIS DO MOTOR
  // ============================================================================

  @Get('configuracoes')
  @Roles('admin', 'gerente')
  listarConfiguracoes() {
    return this.service.listarConfiguracoesMotor();
  }

  @Put('configuracoes')
  @Roles('admin', 'gerente')
  atualizarConfiguracoes(@Body() body: { valores?: unknown }) {
    return this.service.atualizarConfiguracoesMotor(body?.valores);
  }

  @Put('model-selection/:projectKey/:tipo')
  @Roles('admin', 'gerente', 'operador')
  saveModelSelection(
    @Param('projectKey') projectKey: string,
    @Param('tipo') tipo: string,
    @Body() body: { entries: unknown },
  ) {
    if (!body || !Array.isArray(body.entries)) {
      throw new BadRequestException('Body inválido — esperado { entries: [...] }');
    }
    return this.service.saveModelSelection(this.projectKeyOuErro(projectKey), this.tipoOuErro(tipo), body.entries);
  }

  /** Aplica a configuração global e a propaga para todos os projetos. */
  @Put('model-selection/global')
  @Roles('admin', 'gerente')
  saveGlobalModelSelection(@Body() body: unknown) {
    return this.service.saveGlobalModelSelection(body);
  }

  /**
   * Modelos disponíveis no Console OpenClaw (proxy — task-66): alimenta o
   * combo de escolha de modelos por projeto. Admin/gerente escolhem;
   * o console nunca é exposto ao browser.
   */
  @Get('modelos-console')
  // A tela de seleção permite edição para operador (assim como o PUT abaixo),
  // portanto a leitura dos providers/modelos precisa usar a mesma permissão.
  @Roles('admin', 'gerente', 'operador')
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

  @Get('prompts')
  @Roles('admin', 'gerente')
  listarPrompts() {
    return this.service.listarPrompts();
  }

  @Post('prompts/:id/versions')
  @Roles('admin', 'gerente')
  salvarRascunhoPrompt(
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { texto?: string; motivo?: string; contratoVersaoId?: number },
  ) {
    if (!body?.texto?.trim()) throw new BadRequestException('Texto do prompt é obrigatório');
    return this.service.salvarRascunhoPrompt(id, body.texto, body.motivo, usuario.email ?? undefined, body.contratoVersaoId);
  }

  @Post('prompts/:id/publish/:versionId')
  @Roles('admin', 'gerente')
  publicarPrompt(@Param('id', ParseIntPipe) id: number, @Param('versionId', ParseIntPipe) versionId: number) {
    return this.service.publicarVersaoPrompt(id, versionId);
  }

  @Post('prompts/:id/preview')
  @Roles('admin', 'gerente')
  preverPrompt(@Param('id', ParseIntPipe) id: number, @Body() body: { texto?: string; values?: Record<string, unknown>; contratoVersaoId?: number }) {
    if (!body?.texto) throw new BadRequestException('Texto do prompt é obrigatório');
    return this.service.preverPrompt(id, body.texto, body.values ?? {}, body.contratoVersaoId);
  }

  @Post('prompt-contracts/:id/versions')
  @Roles('admin', 'gerente')
  salvarRascunhoContrato(@CurrentUser() usuario: UsuarioAutenticado, @Param('id', ParseIntPipe) id: number, @Body() body: { schemaJson?: unknown; exemploJson?: unknown; instrucoes?: string; motivo?: string }) {
    if (!body?.instrucoes?.trim()) throw new BadRequestException('Instruções do contrato são obrigatórias');
    return this.service.salvarRascunhoContrato(id, body.schemaJson, body.exemploJson, body.instrucoes, body.motivo, usuario.email ?? undefined);
  }

  @Post('prompt-contracts/:id/publish/:versionId')
  @Roles('admin', 'gerente')
  publicarContrato(@Param('id', ParseIntPipe) id: number, @Param('versionId', ParseIntPipe) versionId: number) {
    return this.service.publicarVersaoContrato(id, versionId);
  }

  // ============================================================================
  // GIT INSPECTION (ferramenta de resolução de conflitos)
  // ============================================================================

  /**
   * Lista commits entre base-desenvolvimento e a branch de integração da tarefa.
   * Retorna hash, autor, data e mensagem de cada commit.
   */
  @Get('tarefas/:id/git/commits')
  @Roles('admin', 'gerente', 'operador')
  async listarCommitsTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.listarCommitsTarefa(projeto, id);
  }

  /**
   * Árvore de arquivos em um ref (branch/commit) da tarefa.
   * Query params: ref (opcional, default = branch de integração)
   */
  @Get('tarefas/:id/git/tree')
  @Roles('admin', 'gerente', 'operador')
  async listarArvoreTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Query('ref') ref?: string,
  ) {
    return this.service.listarArvoreTarefa(projeto, id, ref);
  }

  /**
   * Conteúdo de um arquivo em um ref específico da tarefa.
   * Query params: ref (obrigatório), path (obrigatório)
   */
  @Get('tarefas/:id/git/file')
  @Roles('admin', 'gerente', 'operador')
  async conteudoArquivoTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Query('ref') ref: string,
    @Query('path') path: string,
  ) {
    return this.service.conteudoArquivoTarefa(projeto, id, ref, path);
  }

  /**
   * Diff estruturado entre dois refs da tarefa.
   * Query params: from (obrigatório), to (obrigatório)
   */
  @Get('tarefas/:id/git/diff')
  @Roles('admin', 'gerente', 'operador')
  async diffTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.service.diffTarefa(projeto, id, from, to);
  }

  /**
   * Simulação de merge (dry-run) entre a branch de integração e base-desenvolvimento.
   * Retorna success, lista de conflitos com conteúdo conflitante (ours/theirs/base).
   */
  @Post('tarefas/:id/git/merge-simulation')
  @Roles('admin', 'gerente', 'operador')
  async simularMergeTarefa(
    @CurrentProject() projeto: ProjetoResumo,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.simularMergeTarefa(projeto, id);
  }
}

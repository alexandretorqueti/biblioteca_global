/**
 * LembreteAgendadorService — agendador periódico do motor de lembretes
 * (gestao-de-tarefas-global — macro 5, subtarefa 1).
 *
 * Padrão dos reconcilers do repo (`canais-whatsapp.reconciler.ts`) e do
 * agendador de recorrência (macro 4, subtarefa 3): `setInterval` (60s
 * default, `intervalMs` opcional nos testes) + `.unref()` + flag env
 * (`GESTAO_TAREFAS_LEMBRETE_SCHEDULER !== "0"`) + guarda `running` contra
 * sobreposição de ticks.
 *
 * v1 = UM LEMBRETE POR TAREFA (documentado por este header): o disparo é
 * idempotente pelo claim `SELECT ... FOR UPDATE` + pela AUSÊNCIA do
 * marcador `historico_tarefas tipoEvento='lembrete_gerado'` para a tarefa.
 * Consequência aceita: APÓS o disparo, mudar `lembreteAntecedenciaMinutos`
 * para um valor maior NÃO re-notifica — o marcador existe para sempre.
 *
 * Loop de disparo por tick (REQ-F-007):
 * 1. varre `tarefas` do banco do projeto WHERE `prazo IS NOT NULL AND
 *    lembrete_antecedencia_minutos IS NOT NULL AND prazo > agora` (índice
 *    `tarefas_prazo_lembrete_antecedencia_minutos` — migration 0003);
 * 2. filtra a janela do lembrete no domínio puro:
 *    `lembreteVencidoAteAgora(prazo, antecedência, agora)` —
 *    `(prazo - antecedência) <= agora` E `prazo > agora` (domínio
 *    `projects/gestao-de-tarefas-global/src/notificacoes/lembrete.ts`);
 * 3. para cada candidata, em UMA transação MySQL: `SELECT ... FOR UPDATE`
 *    (claim) → re-validação das guards (prazo NULL = sem lembrete, decisão
 *    Alexandre 2026-10-22; antecedência NULL = sem aviso; janela ainda
 *    aberta sob o lock) → checagem de idempotência pelo marcador histórico →
 *    insert em `notificacoes` (`tipo='lembrete'`, `organizacaoId` da tarefa,
 *    `usuarioId` resolvido do responsável via `colaboradores.usuario_id`,
 *    título/corpo com o prazo) → insert do evento
 *    `historico_tarefas tipoEvento='lembrete_gerado'`, NA MESMA transação.
 *
 * DECISÃO "eventos de erro registrados" (mesmo padrão do agendador de
 * recorrência): falha em uma tarefa = `Logger.error` estruturado (JSON com
 * evento/organização/tarefa/motivo), a transação faz rollback (marcador e
 * notificação juntos — retry natural no próximo tick) e as demais tarefas
 * do tick continuam. Colaborador sem `usuario_id` vinculado = sem
 * destinatário → falha isolada registrada (retry: o vínculo pode chegar).
 *
 * NÃO gera push realtime (subtarefa 2) e NÃO expõe HTTP (subtarefa 3 —
 * sino/endpoints); sem mudança de campos em config.ts/config.json.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common"
import { lembreteVencidoAteAgora } from "../../../../../projects/gestao-de-tarefas-global/src/notificacoes/lembrete"
import {
  formatarDatetimeMysql,
  parseDatetimeMysql,
} from "./datetime-mysql"
import {
  LEMBRETE_AGENDADOR_REPOSITORIO,
  type RepositorioLembreteAgendador,
  type TarefaLembreteCandidata,
} from "./lembrete-agendador.repositorio"

export interface LembreteAgendadorOptions {
  /** Intervalo do tick em ms (default 60s; testes injetam valor próprio). */
  intervalMs?: number
  /** Default: ativo enquanto `GESTAO_TAREFAS_LEMBRETE_SCHEDULER !== "0"`. */
  enabled?: boolean
  /** Relógio injetável (determinismo nos testes). */
  now?: () => Date
}

@Injectable()
export class LembreteAgendadorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LembreteAgendadorService.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly intervalMs: number
  private readonly enabled: boolean
  private readonly now: () => Date

  constructor(
    @Inject(LEMBRETE_AGENDADOR_REPOSITORIO)
    private readonly repositorio: RepositorioLembreteAgendador,
    @Optional() options: LembreteAgendadorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000
    this.enabled =
      options.enabled ??
      process.env.GESTAO_TAREFAS_LEMBRETE_SCHEDULER !== "0"
    this.now = options.now ?? (() => new Date())
  }

  onModuleInit(): void {
    if (this.timer || !this.enabled) return
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Um tick: varre tarefas na janela do lembrete e processa cada uma (falha isolada). */
  async tick(): Promise<void> {
    if (this.running || !this.enabled) return
    this.running = true
    try {
      const agora = this.now()
      // Pré-filtro da janela do lembrete com o domínio puro (evita abrir
      // transação/claim para tarefas fora da janela):
      const candidatas = (await this.repositorio.listarTarefasCandidatas(agora)).filter(
        (c) => lembreteVencidoAteAgora(parseDatetimeMysql(c.prazo), c.antecedenciaMinutos, agora),
      )
      for (const candidata of candidatas) {
        try {
          await this.processarTarefa(candidata, agora)
        } catch (erro) {
          // Eventos de erro: logger estruturado; a transação já foi desfeita
          // (notificação + marcador juntos) → retry natural no próximo tick;
          // demais tarefas do tick continuam.
          this.logger.error(
            JSON.stringify({
              evento: "lembrete_disparo_falhou",
              organizacaoId: candidata.organizacaoId,
              tarefaId: candidata.id,
              motivo: erro instanceof Error ? erro.message : String(erro),
            }),
          )
        }
      }
    } catch (erro) {
      // Falha da varredura inteira (banco fora, projeto sem db): registra e
      // tenta de novo no próximo tick.
      this.logger.error(
        JSON.stringify({
          evento: "lembrete_varredura_falhou",
          motivo: erro instanceof Error ? erro.message : String(erro),
        }),
      )
    } finally {
      this.running = false
    }
  }

  /**
   * Disparo do lembrete de UMA tarefa em UMA transação com claim
   * `FOR UPDATE`.
   *
   * O claim re-lê a linha sob lock e re-valida: tarefa sem prazo ou sem
   * antecedência não dispara; janela fechada (prazo venceu esperando o lock)
   * não dispara; marcador `lembrete_gerado` já existente (segundo tick ou
   * peer blue-green) não duplica — é a idempotência de v1 (um lembrete por
   * tarefa).
   */
  private async processarTarefa(
    candidata: TarefaLembreteCandidata,
    agora: Date,
  ): Promise<void> {
    await this.repositorio.emTransacao(async (tx) => {
      const tarefa = await tx.claimTarefa(candidata.id)
      if (!tarefa) return

      // Guards sob lock (o estado pode ter mudado desde a varredura):
      // prazo NULL → proibido lembrete (decisão 2026-10-22); antecedência
      // NULL → sem aviso configurado.
      if (tarefa.prazo === null || tarefa.antecedenciaMinutos === null) return

      // Re-valida a janela com o valor atualizado sob lock: se o prazo já
      // venceu enquanto esperávamos a linha, o aviso perdeu o sentido.
      if (
        !lembreteVencidoAteAgora(
          parseDatetimeMysql(tarefa.prazo),
          tarefa.antecedenciaMinutos,
          agora,
        )
      ) {
        return
      }

      // Idempotência de v1: marcador histórico já existe → lembrete já
      // disparado (segundo tick / dual blue-green). MUDAR a antecedência
      // para um valor maior APÓS o disparo NÃO re-notifica.
      if (await tx.hasLembreteGerado(tarefa.id)) return

      // Destinatário: usuário global do responsável. Sem vínculo = falha
      // isolada registrada (rollback: nada foi gravado; retry no próximo
      // tick — o vínculo do colaborador pode ser criado depois).
      const usuarioId = await tx.resolveUsuarioResponsavel(tarefa.responsavelId)
      if (usuarioId === null) {
        throw new Error(
          `responsavel sem usuario_id vinculado (colaboradores.id=${tarefa.responsavelId})`,
        )
      }

      const titulo = `Lembrete: ${tarefa.titulo}`
      const corpo = `A tarefa "${tarefa.titulo}" vence em ${tarefa.prazo} (${tarefa.antecedenciaMinutos} min de antecedência).`
      const mensagem = `Lembrete gerado em ${formatarDatetimeMysql(agora)} — prazo ${tarefa.prazo} (antecedência ${tarefa.antecedenciaMinutos} min)`

      await tx.inserirNotificacao({
        organizacaoId: tarefa.organizacaoId,
        usuarioId,
        titulo,
        corpo,
        tarefaId: tarefa.id,
      })
      await tx.registrarHistoricoLembreteGerado(tarefa.id, mensagem)
    })
  }
}

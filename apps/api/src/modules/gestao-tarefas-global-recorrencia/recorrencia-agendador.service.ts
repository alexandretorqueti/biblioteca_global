/**
 * RecorrenciaAgendadorService — agendador periódico do motor de recorrência
 * (gestao-de-tarefas-global — macro 4, subtarefa 3).
 *
 * Padrão dos reconcilers do repo (`canais-whatsapp.reconciler.ts`):
 * `setInterval` (60s default, `intervalMs` opcional nos testes) + `.unref()`
 * + flag env (`GESTAO_TAREFAS_RECORRENCIA_SCHEDULER !== "0"`) + guarda
 * `running` contra sobreposição de ticks.
 *
 * Loop de geração por tick (REQ-F-009, REQ-D-009):
 * 1. varre `regras_recorrencia` do banco do projeto WHERE `ativa=true` AND
 *    (`proxima_geracao <= agora` OR `proxima_geracao IS NULL`);
 * 2. para cada regra vencida, em UMA transação MySQL: `SELECT ... FOR UPDATE`
 *    (claim) — a segunda leitura concorrente só gera se o cursor ainda
 *    estiver vencido; isso é a idempotência por `proximaGeracao` sob restart
 *    do agendador e sob dual blue-green (dois processos, mesma tabela);
 * 3. insere a instância via `montarInstancia` (subtarefa 1) em `tarefas`
 *    (vínculo `regraRecorrenciaId`; área/responsável/título copiados);
 * 4. calcula `calcularProximaGeracao` A PARTIR DA OCORRÊNCIA GERADA e atualiza
 *    `proxima_geracao`; quando retorna `null` (dataFim alcançado) marca
 *    `ativa=false` — nunca recalcula a partir de `null` retroativamente.
 *
 * Bootstrap: regra criada com `proximaGeracao` NULL (o CRUD não calcula
 * cursor) → o tick calcula a próxima ocorrência A PARTIR DE AGORA e grava o
 * cursor, SEM gerar instância e sem catch-up retroativo.
 *
 * Encerramento por `dataFim` editado para trás: se o cursor vencido cai
 * depois de `dataFim`, nenhuma instância é gerada e a regra é desativada.
 *
 * DECISÃO "eventos de erro registrados": falha em uma regra = `Logger.error`
 * estruturado (JSON com evento/organização/regra/motivo), `proximaGeracao`
 * NÃO avança (a transação faz rollback; retry no próximo tick) e as demais
 * regras do tick continuam. Sem tabela nova de eventos — não existe no
 * schema e criá-la extrapolaria a ESPEC-CRUD.
 *
 * Não expõe endpoint HTTP nem tela; não gera lembretes (tarefa 5).
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common"
import { montarInstancia } from "../../../../../projects/gestao-de-tarefas-global/src/recorrencia/instancia"
import { calcularProximaGeracao } from "../../../../../projects/gestao-de-tarefas-global/src/recorrencia/proxima-geracao"
import {
  formatarDatetimeMysql,
  parseDatetimeMysql,
} from "./datetime-mysql"
import {
  RECURRENCIA_AGENDADOR_REPOSITORIO,
  type RepositorioRecorrenciaAgendador,
  type RegraVencidaResumo,
} from "./recorrencia-agendador.repositorio"

export interface RecorrenciaAgendadorOptions {
  /** Intervalo do tick em ms (default 60s; testes injetam valor próprio). */
  intervalMs?: number
  /** Default: ativo enquanto `GESTAO_TAREFAS_RECORRENCIA_SCHEDULER !== "0"`. */
  enabled?: boolean
  /** Relógio injetável (determinismo nos testes). */
  now?: () => Date
}

/** "YYYY-MM-DD" local → `Date` à meia-noite local (comparação com dataFim). */
function parseDataLocal(iso: string): Date {
  const partes = iso.split("-").map(Number)
  const ano = partes[0] ?? 1970
  const mes = partes[1] ?? 1
  const dia = partes[2] ?? 1
  return new Date(ano, mes - 1, dia)
}

function inicioDoDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

@Injectable()
export class RecorrenciaAgendadorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RecorrenciaAgendadorService.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly intervalMs: number
  private readonly enabled: boolean
  private readonly now: () => Date

  constructor(
    @Inject(RECURRENCIA_AGENDADOR_REPOSITORIO)
    private readonly repositorio: RepositorioRecorrenciaAgendador,
    @Optional() options: RecorrenciaAgendadorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000
    this.enabled =
      options.enabled ??
      process.env.GESTAO_TAREFAS_RECORRENCIA_SCHEDULER !== "0"
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

  /** Um tick: varre regras vencidas e processa cada uma (falha isolada). */
  async tick(): Promise<void> {
    if (this.running || !this.enabled) return
    this.running = true
    try {
      const agora = this.now()
      const vencidas = await this.repositorio.listarRegrasVencidas(agora)
      for (const resumo of vencidas) {
        try {
          await this.processarRegra(resumo, agora)
        } catch (erro) {
          // Eventos de erro: logger estruturado; cursor NÃO avança (a
          // transação já foi desfeita) → retry natural no próximo tick;
          // demais regras do tick continuam.
          this.logger.error(
            JSON.stringify({
              evento: "recorrencia_geracao_falhou",
              organizacaoId: resumo.organizacaoId,
              regraId: resumo.id,
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
          evento: "recorrencia_varredura_falhou",
          motivo: erro instanceof Error ? erro.message : String(erro),
        }),
      )
    } finally {
      this.running = false
    }
  }

  /**
   * Geração de UMA regra em UMA transação com claim `FOR UPDATE`.
   *
   * O claim re-le a linha sob lock e valida de novo (ativa + cursor ainda
   * vencido): se outro agendador (ou tick anterior) já avançou o cursor,
   * nada é feito — é a idempotência que sobrevive a restart e a dual
   * blue-green.
   */
  private async processarRegra(
    resumo: RegraVencidaResumo,
    agora: Date,
  ): Promise<void> {
    await this.repositorio.emTransacao(async (tx) => {
      const regra = await tx.claimRegra(resumo.id)
      if (!regra || !regra.ativa) return

      // Bootstrap: cursor NULL na criação da regra → calcula a próxima
      // ocorrência a partir de AGORA (sem catch-up retroativo) e não gera
      // instância neste tick.
      if (regra.proximaGeracao === null) {
        const proxima = calcularProximaGeracao(regra, agora)
        if (proxima === null) {
          await tx.encerrarRegra(regra.id)
        } else {
          await tx.avancarProximaGeracao(regra.id, formatarDatetimeMysql(proxima))
        }
        return
      }

      const vencidaEm = parseDatetimeMysql(regra.proximaGeracao)
      // Claim idempotente: outro processo já avançou o cursor (não está mais
      // vencido) — segunda leitura não gera.
      if (vencidaEm.getTime() > agora.getTime()) return

      // dataFim editado para trás: a ocorrência vencida caiu depois do fim
      // — encerra sem gerar.
      if (
        regra.dataFim !== null &&
        inicioDoDia(vencidaEm) > parseDataLocal(regra.dataFim)
      ) {
        await tx.encerrarRegra(regra.id)
        return
      }

      // Geração: instância (vínculo regraRecorrenciaId) + cursor a partir da
      // ocorrência gerada (nunca a partir de `agora`, para ciclos curtos não
      // pularem ocorrência; nunca a partir de `null` retroativamente).
      const instancia = montarInstancia(regra, agora)
      await tx.inserirInstancia(instancia)
      const proxima = calcularProximaGeracao(regra, vencidaEm)
      if (proxima === null) {
        await tx.encerrarRegra(regra.id)
      } else {
        await tx.avancarProximaGeracao(regra.id, formatarDatetimeMysql(proxima))
      }
    })
  }
}

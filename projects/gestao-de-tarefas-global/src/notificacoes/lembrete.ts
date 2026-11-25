/**
 * Domínio puro do lembrete de prazo (gestao-de-tarefas-global — macro 5,
 * subtarefa 1).
 *
 * Sem Nest, sem DB, sem I/O: funções puras sobre `Date` (relógio do
 * chamador injetado — o agendador passa `now()`), no fuso LOCAL do
 * processo (a suíte raiz roda com TZ=UTC — vitest.config.ts).
 *
 * Semântica (aceite — macro 5, subtarefa 1; decisão Alexandre 2026-10-22
 * "lembrete é sempre x antes do prazo"):
 * - `calcularMomentoLembrete(prazo, antecedenciaMinutos)`: instante exato do
 *   aviso = `prazo - antecedência`. `antecedenciaMinutos = 0` = no próprio
 *   prazo; valor maior = mais cedo;
 * - `lembreteVencidoAteAgora(prazo, antecedenciaMinutos, agora)`: o lembrete
 *   deve disparar NESTE tick quando o momento chegou (`momento <= agora`) E o
 *   prazo ainda está no futuro (`prazo > agora`) — depois do prazo não se
 *   avisa "faltam x min para uma tarefa que já venceu";
 * - tarefa sem prazo (`prazo = null`) nunca gera lembrete: as funções são
 *   sobre o momento já resolvido; a guarda `prazo IS NOT NULL AND
 *   lembrete_antecedencia_minutos IS NOT NULL` fica na varredura do
 *   agendador (SQL) e no claim re-validado pela ausência de valor nulo.
 *
 * `antecedenciaMinutos < 0` é tratado como 0 (máquina de tempo para trás
 * não existe; o CRUD valida, mas o domínio não estoura — clamp defensivo).
 */

/** Clamp defensivo: antecedência negativa → 0 (sem tempo negativo). */
function antecedenciaEfetiva(antecedenciaMinutos: number): number {
  return antecedenciaMinutos > 0 ? antecedenciaMinutos : 0
}

/**
 * Momento exato do lembrete: `prazo - antecedenciaMinutos` (minutos).
 *
 * Pureza: recebe `Date` e devolve `Date`; não lê relógio nenhum.
 */
export function calcularMomentoLembrete(
  prazo: Date,
  antecedenciaMinutos: number,
): Date {
  return new Date(prazo.getTime() - antecedenciaEfetiva(antecedenciaMinutos) * 60_000)
}

/**
 * Predicado "lembrete vencido até agora": `momentoLembrete <= agora` E
 * `prazo > agora` (o prazo precisa ainda estar no futuro para o aviso fazer
 * sentido).
 *
 * É exatamente a janela varrida pelo agendador:
 * `WHERE prazo IS NOT NULL AND lembrete_antecedencia_minutos IS NOT NULL
 *   AND (prazo - antecedência) <= agora AND prazo > agora`.
 *
 * Idempotência de v1 (UM lembrete por tarefa) NÃO é responsabilidade desta
 * função — é o claim `FOR UPDATE` + o marcador `historico_tarefas
 * tipoEvento='lembrete_gerado'` no agendador quem garante que o segundo
 * tick (ou o peer blue-green) não duplica.
 */
export function lembreteVencidoAteAgora(
  prazo: Date,
  antecedenciaMinutos: number,
  agora: Date,
): boolean {
  const momento = calcularMomentoLembrete(prazo, antecedenciaMinutos)
  return momento.getTime() <= agora.getTime() && prazo.getTime() > agora.getTime()
}

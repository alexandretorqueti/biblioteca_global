/**
 * Estatísticas de duração de subtarefas concluídas por modelo (tarefa 1100).
 *
 * Função pura exportada para permitir teste unitário (critério da subtarefa).
 *
 * Critério de outlier (decisão de engenharia registrada): uma execução é
 * outlier quando sua duração é estritamente maior que 2x a média simples do
 * conjunto. A média exibida é recalculada sem os outliers.
 * Exemplo: [3, 4, 5, 20] (min) → média simples 8, limiar 16, outlier 20 →
 * média exibida 4, `temOutlier` true, `maiorDesvio` 20.
 */

export type EstatisticasModelo = {
  /** Média das durações (s) EXCLUINDO os outliers; 0 quando não há dados. */
  media: number;
  /** true quando houve ao menos uma execução excluída como outlier. */
  temOutlier: boolean;
  /** Duração (s) da execução outlier mais lenta; 0 quando `temOutlier` é false. */
  maiorDesvio: number;
  /** Total de execuções válidas consideradas no conjunto. */
  totalSubtarefas: number;
};

/** Multiplicador do limiar de outlier: duração > 2x a média simples. */
export const MULTIPLICADOR_OUTLIER = 2;

export function calcularEstatisticasModelo(duracoes: number[]): EstatisticasModelo {
  const validas = duracoes.filter((d) => Number.isFinite(d) && d > 0);
  if (validas.length === 0) {
    return { media: 0, temOutlier: false, maiorDesvio: 0, totalSubtarefas: 0 };
  }
  const soma = validas.reduce((acerto, valor) => acerto + valor, 0);
  const mediaSimples = soma / validas.length;
  const limiar = mediaSimples * MULTIPLICADOR_OUTLIER;
  const normais = validas.filter((d) => d <= limiar);
  const outliers = validas.filter((d) => d > limiar);
  // Proteção para o caso degenerado em que todo o conjunto seria descartado
  // (impossível com 2+ valores positivos, mas defensável com 1 valor).
  const base = normais.length > 0 ? normais : validas;
  const media = base.reduce((acerto, valor) => acerto + valor, 0) / base.length;
  const maiorDesvio = outliers.length > 0 ? Math.max(...outliers) : 0;
  return {
    media,
    temOutlier: outliers.length > 0,
    maiorDesvio,
    totalSubtarefas: validas.length,
  };
}

/** Formata segundos como `Xmin Ys` / `Xmin` / `Ys` (inteiros truncados). */
export function formatarDuracaoModelo(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos <= 0) return "0s";
  const total = Math.round(segundos);
  const minutos = Math.floor(total / 60);
  const resto = total % 60;
  if (minutos === 0) return `${resto}s`;
  return resto === 0 ? `${minutos}min` : `${minutos}min ${resto}s`;
}

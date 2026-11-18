export type IntervaloDuracao = {
  inicio: Date;
  fim: Date;
  detalhe?: string;
  phase?: string;
  estimado?: boolean;
  emAndamento?: boolean;
};

export type IntervaloNumerico = IntervaloDuracao & { inicioMs: number; fimMs: number };

const segundo = 1000;

function numeroData(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Une ranges sobrepostos (inclusive ranges adjacentes) sem contar tempo duas vezes. */
export function mergeIntervals(intervalos: IntervaloDuracao[], agora = new Date()): IntervaloDuracao[] {
  const validos: IntervaloNumerico[] = intervalos
    .map((item) => ({ ...item, inicioMs: numeroData(item.inicio), fimMs: numeroData(item.fim) }))
    .filter((item) => Number.isFinite(item.inicioMs) && Number.isFinite(item.fimMs) && item.fimMs > item.inicioMs)
    .map((item) => ({ ...item, fim: item.fimMs > agora.getTime() ? agora : item.fim }));
  validos.sort((a, b) => a.inicioMs - b.inicioMs || a.fimMs - b.fimMs);
  const merged: IntervaloNumerico[] = [];
  for (const atual of validos) {
    const anterior = merged[merged.length - 1];
    if (!anterior || atual.inicioMs > anterior.fimMs) {
      merged.push({ ...atual });
      continue;
    }
    if (atual.fimMs > anterior.fimMs) {
      anterior.fimMs = atual.fimMs;
      anterior.fim = atual.fim;
    }
    anterior.estimado = anterior.estimado || atual.estimado;
    anterior.emAndamento = anterior.emAndamento || atual.emAndamento;
  }
  return merged.map(({ inicioMs: _inicioMs, fimMs: _fimMs, ...item }) => item);
}

/** Remove de cada intervalo as janelas de pausa. */
export function subtractIntervals(intervalos: IntervaloDuracao[], pausas: IntervaloDuracao[]): IntervaloDuracao[] {
  const bloqueios = mergeIntervals(pausas);
  return intervalos.flatMap((original) => {
    let partes: IntervaloDuracao[] = [original];
    for (const pausa of bloqueios) {
      const pInicio = numeroData(pausa.inicio);
      const pFim = numeroData(pausa.fim);
      partes = partes.flatMap((parte) => {
        const inicio = numeroData(parte.inicio);
        const fim = numeroData(parte.fim);
        if (pFim <= inicio || pInicio >= fim) return [parte];
        const resultado: IntervaloDuracao[] = [];
        if (pInicio > inicio) resultado.push({ ...parte, fim: new Date(pInicio) });
        if (pFim < fim) resultado.push({ ...parte, inicio: new Date(pFim) });
        return resultado;
      });
    }
    return partes;
  });
}

export function intervalSeconds(intervalos: IntervaloDuracao[]): number {
  return Math.floor(intervalos.reduce((total, item) => total + Math.max(0, numeroData(item.fim) - numeroData(item.inicio)), 0) / segundo);
}

export function iso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

export function limitarAoProximoInicio(intervalos: IntervaloDuracao[], proximosInicios: Date[]): IntervaloDuracao[] {
  return intervalos.map((item) => {
    const inicio = numeroData(item.inicio);
    const limite = proximosInicios.map(numeroData).filter((valor) => valor > inicio).sort((a, b) => a - b)[0];
    if (limite === undefined || limite >= numeroData(item.fim)) return item;
    return { ...item, fim: new Date(limite), estimado: true };
  }).filter((item) => numeroData(item.fim) > numeroData(item.inicio));
}

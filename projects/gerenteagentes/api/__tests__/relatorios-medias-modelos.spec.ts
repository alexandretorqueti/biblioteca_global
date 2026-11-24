// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  calcularEstatisticasModelo,
  formatarDuracaoModelo,
} from "../relatorios-medias-modelos";

describe("calcularEstatisticasModelo", () => {
  it("caso do exemplo [3, 4, 5, 20]: exclui o outlier e resulta em média 4", () => {
    const resultado = calcularEstatisticasModelo([3, 4, 5, 20]);
    expect(resultado.media).toBeCloseTo(4);
    expect(resultado.temOutlier).toBe(true);
    expect(resultado.maiorDesvio).toBe(20);
    expect(resultado.totalSubtarefas).toBe(4);
  });

  it("caso sem outlier [3, 4, 5]: flag false e maior desvio 0", () => {
    const resultado = calcularEstatisticasModelo([3, 4, 5]);
    expect(resultado.media).toBeCloseTo(4);
    expect(resultado.temOutlier).toBe(false);
    expect(resultado.maiorDesvio).toBe(0);
  });

  it("com outlier alto: maior desvio é a execução outlier mais lenta", () => {
    // soma 115, média simples 19,25, limiar 38,5 → outlier 60;
    // média sem outliers (2+4+8+16+25)/5 = 11
    const resultado = calcularEstatisticasModelo([2, 4, 8, 16, 25, 60]);
    expect(resultado.temOutlier).toBe(true);
    expect(resultado.maiorDesvio).toBe(60);
    expect(resultado.media).toBeCloseTo(11);
  });

  it("valores no limiar (exatamente 2x a média) não são outliers", () => {
    // [2, 4]: média 3, limiar 6 → nada acima de 6 → sem outlier
    const resultado = calcularEstatisticasModelo([2, 4]);
    expect(resultado.temOutlier).toBe(false);
    expect(resultado.media).toBeCloseTo(3);
  });

  it("conjunto vazio: zeros e flag false", () => {
    const resultado = calcularEstatisticasModelo([]);
    expect(resultado).toEqual({ media: 0, temOutlier: false, maiorDesvio: 0, totalSubtarefas: 0 });
  });

  it("ignora durações inválidas (0, negativo, NaN)", () => {
    const resultado = calcularEstatisticasModelo([0, -5, Number.NaN, 10, 12]);
    expect(resultado.totalSubtarefas).toBe(2);
    expect(resultado.media).toBeCloseTo(11);
    expect(resultado.temOutlier).toBe(false);
  });
});

describe("formatarDuracaoModelo", () => {
  it("formata min/seg", () => {
    expect(formatarDuracaoModelo(240)).toBe("4min");
    expect(formatarDuracaoModelo(245)).toBe("4min 5s");
    expect(formatarDuracaoModelo(45)).toBe("45s");
    expect(formatarDuracaoModelo(0)).toBe("0s");
  });
});

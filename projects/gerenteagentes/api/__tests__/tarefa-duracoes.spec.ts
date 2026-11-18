import { describe, expect, it } from 'vitest';
import {
  intervalSeconds,
  limitarAoProximoInicio,
  mergeIntervals,
  subtractIntervals,
} from '../tarefa-duracoes';

const d = (value: string) => new Date(`2026-01-01T${value}:00Z`);
const intervalo = (inicio: string, fim: string, extras = {}) => ({ inicio: d(inicio), fim: d(fim), ...extras });

describe('tarefa-duracoes', () => {
  it('une sessões sobrepostas sem contagem dupla', () => {
    const resultado = mergeIntervals([intervalo('00:00', '00:10'), intervalo('00:05', '00:20')]);
    expect(intervalSeconds(resultado)).toBe(20 * 60);
  });

  it('desconta integralmente uma janela de pausa', () => {
    const resultado = subtractIntervals([intervalo('00:00', '01:00')], [intervalo('00:20', '00:40')]);
    expect(intervalSeconds(resultado)).toBe(40 * 60);
    expect(resultado).toHaveLength(2);
  });

  it('limita sessão órfã ao início da fase seguinte e mantém marca estimada', () => {
    const resultado = limitarAoProximoInicio(
      [intervalo('00:00', '01:00', { estimado: true })],
      [d('00:30')],
    );
    expect(intervalSeconds(resultado)).toBe(30 * 60);
    expect(resultado[0]!.estimado).toBe(true);
  });

  it('permite atividade aberta até agora e preserva flag em andamento no merge', () => {
    const agora = d('00:30');
    const resultado = mergeIntervals([intervalo('00:00', '01:00', { emAndamento: true })], agora);
    expect(intervalSeconds(resultado)).toBe(30 * 60);
    expect(resultado[0]!.emAndamento).toBe(true);
  });
});

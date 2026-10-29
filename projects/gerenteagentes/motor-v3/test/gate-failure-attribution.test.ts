import { describe, expect, it } from 'vitest'
import {
  attributeGateFailure,
  extractCwdPrefixes,
  extractFailurePaths,
  pathsMatch,
  resolveEvidencePath,
} from '../src/deploy/GateFailureAttribution.js'

/**
 * Atribuição de culpa em falha do gate pre_deploy do commit composto
 * (incidente 2026-10-23): só isola membros com evidência inequívoca.
 */
describe('extractCwdPrefixes', () => {
  it('extrai prefixos cd de comandos encadeados', () => {
    expect(extractCwdPrefixes([
      'cd projects/gerenteagentes/motor-v3 && npm ci --prefer-offline && npm run build',
      'cd projects/gerenteagentes/motor-v3 && npx vitest run',
    ])).toEqual(['projects/gerenteagentes/motor-v3'])
  })

  it('retorna vazio sem cd', () => {
    expect(extractCwdPrefixes(['npm ci && npm run build', null, undefined])).toEqual([])
  })
})

describe('resolveEvidencePath', () => {
  it('caminho repo-rooted permanece absoluto', () => {
    expect(resolveEvidencePath('projects/x/migrations/0001_a.sql', ['apps/y'])).toEqual(['projects/x/migrations/0001_a.sql'])
  })

  it('caminho relativo recebe todos os prefixos de cwd', () => {
    expect(resolveEvidencePath('src/start.ts', ['projects/motor-v3', 'apps/web']))
      .toEqual(['projects/motor-v3/src/start.ts', 'apps/web/src/start.ts'])
  })

  it('normaliza ./ e / iniciais', () => {
    expect(resolveEvidencePath('./src/a.ts', [])).toEqual(['src/a.ts'])
  })
})

describe('extractFailurePaths', () => {
  it('erro de tsc com cwd do comando de build (incidente batch 142)', () => {
    const paths = extractFailurePaths({
      stdout: '\nadded 83 packages in 3s\nsrc/start.ts(645,11): error TS2304: Cannot find name \'ConsoleHumanNotifier\'.\nsrc/start.ts(703,84): error TS2304: Cannot find name \'ConsoleHumanNotifier\'.\n',
      stderr: 'npm warn deprecated @esbuild-kit/esm-loader@2.6.5\n',
      buildCommand: 'cd projects/gerenteagentes/motor-v3 && npm ci --prefer-offline --no-audit --no-fund && npm run build',
      testCommand: 'cd projects/gerenteagentes/motor-v3 && npx vitest run',
    })
    expect(paths).toContain('projects/gerenteagentes/motor-v3/src/start.ts')
  })

  it('bullet de dry-run de migration (incidente batch 143)', () => {
    const paths = extractFailurePaths({
      stdout: '',
      stderr: 'Dry-run de migrations falhou em tabelas scratch:\n- projects/gestao-de-tarefas-global/migrations/0001_smooth_storm.sql (statement 3, linha 23): Table \'projeto_1.gate_scratch_1028_recorrencias\' doesn\'t exist [errno=1146]\nCorrija os erros de SQL antes de concluir a entrega.',
    })
    expect(paths).toContain('projects/gestao-de-tarefas-global/migrations/0001_smooth_storm.sql')
  })

  it('FAIL de vitest com caminho repo-rooted', () => {
    const paths = extractFailurePaths({
      stdout: ' FAIL  projects/x/test/a.test.ts > suíte > caso\n',
      stderr: '',
    })
    expect(paths).toContain('projects/x/test/a.test.ts')
  })

  it('sem caminhos → lista vazia', () => {
    expect(extractFailurePaths({ stdout: 'ok', stderr: '' })).toEqual([])
  })
})

/**
 * Incidente 2026-10-29 (batch deploy-bbc579dd): a saída do gate pre_deploy é
 * gravada com códigos ANSI. `FAIL\x1b[22m\x1b[49m test/x.test.ts` não casava com
 * nenhum padrão → evidencePaths vazio → attribution nula → o batch inteiro foi
 * bloqueado (1039/1044 inocentes) por uma falha de teste do membro 1043.
 */
describe('extractFailurePaths — saída com ANSI (incidente batch 161)', () => {
  const testCommand = 'cd projects/gerenteagentes/motor-v3 && npx vitest run'
  // Réplica fiel (bytes reais do test_run 986) do bloco de falha do vitest.
  const ansiStderr = [
    '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m test/terminal-failure-blocker-alert.test.ts\u001b[2m > \u001b[22mresetTaskToReady > SubtaskExecutionConsumer repassa a causa\u001b[0m',
    'TypeError: this.repository.getDevelopmentModelChain is not a function',
    ' \u001b[2m❯\u001b[22m src/execution/SubtaskExecutionConsumer.ts\u001b[2m:\u001b[22m97\u001b[2m:\u001b[22m42\u001b[22m',
    ' \u001b[2m❯\u001b[22m test/terminal-failure-blocker-alert.test.ts\u001b[2m:\u001b[22m379\u001b[2m:\u001b[22m5\u001b[22m',
  ].join('\n')

  it('FAIL com códigos ANSI ao redor extrai o caminho do teste', () => {
    const paths = extractFailurePaths({ stdout: '', stderr: ansiStderr, testCommand })
    expect(paths).toContain('projects/gerenteagentes/motor-v3/test/terminal-failure-blocker-alert.test.ts')
  })

  it('frame ❯ arquivo:linha:col extrai o caminho sem o sufixo', () => {
    const paths = extractFailurePaths({ stdout: '', stderr: ansiStderr, testCommand })
    expect(paths).toContain('projects/gerenteagentes/motor-v3/src/execution/SubtaskExecutionConsumer.ts')
  })

  it('cenário completo do incidente: isola o membro culpado e preserva inocentes', () => {
    const memberFiles = new Map<number, string[]>([
      [1039, ['apps/web/src/projects/gerenteagentes/screens/OperationMapScreen.tsx']],
      [1044, ['projects/gerenteagentes/motor-v3/src/coordinator/CancelTerminalGuard.ts']],
      [1043, [
        'projects/gerenteagentes/motor-v3/test/terminal-failure-blocker-alert.test.ts',
        'projects/gerenteagentes/motor-v3/src/execution/SubtaskExecutionConsumer.ts',
      ]],
    ])
    const evidencePaths = extractFailurePaths({ stdout: '', stderr: ansiStderr, testCommand })
    const attribution = attributeGateFailure(memberFiles, evidencePaths)
    expect(attribution).not.toBeNull()
    expect(attribution!.culprits).toEqual([1043])
  })
})

describe('pathsMatch', () => {
  it('match por sufixo com fronteira de diretório', () => {
    expect(pathsMatch('projects/motor-v3/src/start.ts', 'src/start.ts')).toBe(true)
    expect(pathsMatch('projects/motor-v3/src/start.ts', 'projects/motor-v3/src/start.ts')).toBe(true)
  })

  it('sem falso positivo por sufixo parcial de nome', () => {
    expect(pathsMatch('projects/a/src/mystart.ts', 'src/start.ts')).toBe(false)
  })
})

describe('attributeGateFailure', () => {
  const members = new Map<number, string[]>([
    [1, ['projects/motor-v3/src/notifier.ts']],
    [2, ['projects/motor-v3/src/start.ts', 'projects/motor-v3/src/other.ts']],
    [3, ['projects/x/README.md']],
  ])

  it('evidência em 1 de 3 membros → isola só ele', () => {
    const result = attributeGateFailure(members, ['projects/motor-v3/src/start.ts'])
    expect(result).not.toBeNull()
    expect(result!.culprits).toEqual([2])
    expect(result!.matches).toEqual([
      { databaseTaskId: 2, evidencePath: 'projects/motor-v3/src/start.ts', memberFile: 'projects/motor-v3/src/start.ts' },
    ])
  })

  it('evidência em todos os membros → não atribui (bloqueio total)', () => {
    const all = new Map<number, string[]>([
      [1, ['src/shared.ts']],
      [2, ['projects/motor-v3/src/shared.ts']],
    ])
    expect(attributeGateFailure(all, ['src/shared.ts'])).toBeNull()
  })

  it('sem evidência → não atribui', () => {
    expect(attributeGateFailure(members, [])).toBeNull()
  })

  it('evidência que não toca nenhum membro → não atribui', () => {
    expect(attributeGateFailure(members, ['projects/z/src/x.ts'])).toBeNull()
  })

  it('membro único → não atribui', () => {
    expect(attributeGateFailure(new Map([[1, ['src/a.ts']]]), ['src/a.ts'])).toBeNull()
  })

  it('match tolerante a caminho relativo de tsc', () => {
    const result = attributeGateFailure(members, ['src/start.ts'])
    expect(result!.culprits).toEqual([2])
  })
})

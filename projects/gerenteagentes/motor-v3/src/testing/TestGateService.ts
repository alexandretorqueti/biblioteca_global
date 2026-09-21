import { createHash } from 'node:crypto'
import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

const execAsync = promisify(exec)
const gzipAsync = promisify(gzipCallback)
const ANSI = /\u001b\[[0-9;]*m/g

export type TestRunPhase = 'baseline' | 'post_dev' | 'rework' | 'monitor_recovery' | 'pre_deploy'
export type FailureClassification = 'unclassified' | 'new' | 'pre_existing' | 'resolved' | 'worsened' | 'flaky_or_inconclusive'

export interface TestFailureRecord {
  fingerprint: string
  suite: string
  testCase?: string
  errorType?: string
  normalizedMessage: string
  sourceFile?: string
  sourceLine?: number
  rawExcerpt: string
  occurrenceCount: number
  classification: FailureClassification
}

export interface TestRunResult {
  id: number
  phase: TestRunPhase
  status: 'passed' | 'failed' | 'inconclusive'
  comparisonStatus: 'not_compared' | 'no_regression' | 'regression' | 'inconclusive'
  exitCode: number
  failures: TestFailureRecord[]
  newFailures: TestFailureRecord[]
  preExistingFailures: TestFailureRecord[]
  resolvedFailures: TestFailureRecord[]
  stdout: string
  stderr: string
}

export interface TestGateInput {
  projectId: number
  taskDatabaseId: number
  subtaskId?: number
  phase: TestRunPhase
  baselineRunId?: number
  commitSha: string
  baseCommitSha?: string
  branchName: string
  workspacePath: string
  buildCommand: string
  testCommand: string
}

interface FailureRow extends RowDataPacket {
  fingerprint: string
  suite: string
  test_case: string | null
  error_type: string | null
  normalized_message: string
  source_file: string | null
  source_line: number | null
  raw_excerpt: string | null
  occurrence_count: number
}

interface RunEnvironmentRow extends RowDataPacket { environment_fingerprint: string }
interface FailureComparison {
  current: TestFailureRecord[]
  newFailures: TestFailureRecord[]
  preExistingFailures: TestFailureRecord[]
  resolvedFailures: TestFailureRecord[]
}

export class TestGateService {
  constructor(private readonly pool: Pool) {}

  async run(input: TestGateInput): Promise<TestRunResult> {
    const startedAt = new Date()
    const environment = await this.environment(input.workspacePath, input.buildCommand, input.testCommand)
    if (input.phase === 'baseline') {
      const reused = await this.reuseBaseline(input, environment.fingerprint)
      if (reused) return reused
    }
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      const build = await execAsync(input.buildCommand, { cwd: input.workspacePath, timeout: 300_000, maxBuffer: 20 * 1024 * 1024 })
      stdout += build.stdout
      stderr += build.stderr
      const tests = await execAsync(input.testCommand, { cwd: input.workspacePath, timeout: 300_000, maxBuffer: 30 * 1024 * 1024 })
      stdout += tests.stdout
      stderr += tests.stderr
    } catch (error: any) {
      exitCode = Number(error?.code) || 1
      stdout += String(error?.stdout ?? '')
      stderr += String(error?.stderr ?? error?.message ?? '')
    }

    const failures = this.parseFailures(`${stdout}\n${stderr}`)
    let status: TestRunResult['status'] = exitCode === 0 ? 'passed' : 'failed'
    const baseline = input.baselineRunId ? await this.failuresForRun(input.baselineRunId) : []
    const baselineEnvironment = input.baselineRunId ? await this.environmentForRun(input.baselineRunId) : null
    const comparable = !baselineEnvironment || baselineEnvironment === environment.fingerprint
    let compared = comparable
      ? this.compare(failures, baseline, Boolean(input.baselineRunId))
      : this.inconclusive(failures, baseline)
    let flakyDetected = false
    if (input.baselineRunId && comparable && compared.newFailures.length > 0 && Number(process.env.MOTOR_TEST_FLAKY_RETRIES ?? 1) > 0) {
      const confirmation = await this.confirmFailures(input)
      const confirmed = new Set(confirmation.map(failure => failure.fingerprint))
      const unstable = compared.newFailures.filter(failure => !confirmed.has(failure.fingerprint))
      if (unstable.length > 0) {
        flakyDetected = true
        for (const failure of unstable) failure.classification = 'flaky_or_inconclusive'
        compared = {
          ...compared,
          newFailures: compared.newFailures.filter(failure => confirmed.has(failure.fingerprint)),
        }
        status = 'inconclusive'
      }
    }
    const comparisonStatus = !input.baselineRunId
      ? 'not_compared'
      : !comparable ? 'inconclusive'
      : flakyDetected ? 'inconclusive'
      : compared.newFailures.length > 0 ? 'regression' : 'no_regression'
    const finishedAt = new Date()
    const summary = this.summary(`${stdout}\n${stderr}`)
    const [inserted] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO test_runs
        (projeto_id, tarefa_id, subtarefa_id, phase, baseline_run_id, commit_sha, base_commit_sha,
         branch_name, workspace_path, build_command, test_command, environment_fingerprint,
         environment_json, node_version, lockfile_hash, started_at, finished_at, exit_code, status,
         comparison_status, passed_count, failed_count, stdout, stderr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.projectId, input.taskDatabaseId, input.subtaskId ?? null, input.phase, input.baselineRunId ?? null,
        input.commitSha, input.baseCommitSha ?? null, input.branchName, input.workspacePath,
        input.buildCommand, input.testCommand, environment.fingerprint, JSON.stringify(environment.evidence), process.version, environment.lockfileHash,
        startedAt, finishedAt, exitCode, status, comparisonStatus, summary.passed, summary.failed,
        this.summaryLog(stdout), this.summaryLog(stderr)],
    )
    const runId = inserted.insertId
    try {
      const artifacts = await this.persistArtifacts(runId, stdout, stderr)
      await this.pool.execute(
        'UPDATE test_runs SET stdout_artifact_path=?, stderr_artifact_path=? WHERE id=?',
        [artifacts.stdout, artifacts.stderr, runId],
      )
    } catch {
      // Falha no armazenamento do artefato não pode apagar o resultado do
      // gate; o resumo permanece no banco e o deploy continua obedecendo-o.
    }
    const all = [...compared.current, ...compared.resolvedFailures]
    for (const failure of all) await this.insertFailure(runId, failure)
    return {
      id: runId, phase: input.phase, status, comparisonStatus, exitCode,
      failures: compared.current, newFailures: compared.newFailures,
      preExistingFailures: compared.preExistingFailures, resolvedFailures: compared.resolvedFailures,
      stdout, stderr,
    }
  }

  async failuresForRun(runId: number): Promise<TestFailureRecord[]> {
    const [rows] = await this.pool.query<FailureRow[]>(
      `SELECT fingerprint, suite, test_case, error_type, normalized_message, source_file,
              source_line, raw_excerpt, occurrence_count
         FROM test_failures WHERE test_run_id = ?`, [runId],
    )
    return rows.map(row => ({
      fingerprint: row.fingerprint, suite: row.suite,
      ...(row.test_case ? { testCase: row.test_case } : {}),
      ...(row.error_type ? { errorType: row.error_type } : {}),
      normalizedMessage: row.normalized_message,
      ...(row.source_file ? { sourceFile: row.source_file } : {}),
      ...(row.source_line ? { sourceLine: Number(row.source_line) } : {}),
      rawExcerpt: row.raw_excerpt ?? '', occurrenceCount: Number(row.occurrence_count), classification: 'unclassified',
    }))
  }

  private async reuseBaseline(input: TestGateInput, environmentFingerprint: string): Promise<TestRunResult | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: number }>>(
      `SELECT id FROM test_runs
        WHERE projeto_id=? AND phase='baseline' AND commit_sha=?
          AND environment_fingerprint=? AND build_command=? AND test_command=?
        ORDER BY finished_at DESC, id DESC LIMIT 1`,
      [input.projectId, input.commitSha, environmentFingerprint, input.buildCommand, input.testCommand],
    )
    const sourceId = Number(rows[0]?.id ?? 0)
    if (!sourceId) return null
    const [inserted] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO test_runs
        (projeto_id,tarefa_id,subtarefa_id,phase,baseline_run_id,reused_from_run_id,commit_sha,base_commit_sha,
         branch_name,workspace_path,build_command,test_command,environment_fingerprint,environment_json,node_version,
         lockfile_hash,started_at,finished_at,exit_code,status,comparison_status,passed_count,failed_count,
         stdout,stderr,stdout_artifact_path,stderr_artifact_path)
       SELECT ?,?,?, 'baseline',NULL,id,?,?, ?,?,?,?,environment_fingerprint,environment_json,node_version,
              lockfile_hash,NOW(3),NOW(3),exit_code,status,'not_compared',passed_count,failed_count,
              stdout,stderr,stdout_artifact_path,stderr_artifact_path
         FROM test_runs WHERE id=?`,
      [input.projectId, input.taskDatabaseId, input.subtaskId ?? null, input.commitSha, input.baseCommitSha ?? null,
        input.branchName, input.workspacePath, input.buildCommand, input.testCommand, sourceId],
    )
    const runId = inserted.insertId
    await this.pool.execute(
      `INSERT INTO test_failures
        (test_run_id,fingerprint_version,fingerprint,suite,test_case,error_type,normalized_message,
         source_file,source_line,raw_excerpt,occurrence_count,classification)
       SELECT ?,fingerprint_version,fingerprint,suite,test_case,error_type,normalized_message,
              source_file,source_line,raw_excerpt,occurrence_count,'unclassified'
         FROM test_failures WHERE test_run_id=?`,
      [runId, sourceId],
    )
    const [runRows] = await this.pool.query<Array<RowDataPacket & { status: 'passed' | 'failed' | 'inconclusive'; exit_code: number; stdout: string | null; stderr: string | null }>>(
      'SELECT status,exit_code,stdout,stderr FROM test_runs WHERE id=?', [runId],
    )
    const run = runRows[0]!
    const failures = await this.failuresForRun(runId)
    return {
      id: runId, phase: 'baseline', status: run.status, comparisonStatus: 'not_compared',
      exitCode: Number(run.exit_code), failures, newFailures: [], preExistingFailures: [], resolvedFailures: [],
      stdout: run.stdout ?? '', stderr: run.stderr ?? '',
    }
  }

  formatNewFailures(run: TestRunResult): string {
    return run.newFailures.map((failure, index) =>
      `${index + 1}. ${failure.suite}${failure.testCase ? ` > ${failure.testCase}` : ''}: ${failure.normalizedMessage}`,
    ).join('\n')
  }

  compare(current: TestFailureRecord[], baseline: TestFailureRecord[], hasBaseline = true): FailureComparison {
    if (!hasBaseline) return { current, newFailures: [], preExistingFailures: [], resolvedFailures: [] }
    const before = new Map(baseline.map(failure => [failure.fingerprint, failure]))
    const after = new Map(current.map(failure => [failure.fingerprint, failure]))
    const newFailures: TestFailureRecord[] = []
    const preExistingFailures: TestFailureRecord[] = []
    for (const failure of current) {
      const previous = before.get(failure.fingerprint)
      if (previous) {
        if (failure.occurrenceCount > previous.occurrenceCount) {
          failure.classification = 'worsened'
          newFailures.push(failure)
        } else {
          failure.classification = 'pre_existing'
          preExistingFailures.push(failure)
        }
      } else {
        failure.classification = 'new'
        newFailures.push(failure)
      }
    }
    const resolvedFailures = baseline.filter(failure => !after.has(failure.fingerprint)).map(failure => ({ ...failure, classification: 'resolved' as const }))
    return { current, newFailures, preExistingFailures, resolvedFailures }
  }

  private inconclusive(current: TestFailureRecord[], baseline: TestFailureRecord[]): FailureComparison {
    const marked = current.map(failure => ({ ...failure, classification: 'flaky_or_inconclusive' as const }))
    return { current: marked, newFailures: [], preExistingFailures: [], resolvedFailures: baseline.filter(failure => !current.some(item => item.fingerprint === failure.fingerprint)).map(failure => ({ ...failure, classification: 'flaky_or_inconclusive' as const })) }
  }

  private async environmentForRun(runId: number): Promise<string | null> {
    const [rows] = await this.pool.query<RunEnvironmentRow[]>(`SELECT environment_fingerprint FROM test_runs WHERE id=? LIMIT 1`, [runId])
    return rows[0]?.environment_fingerprint ?? null
  }

  parseFailures(raw: string): TestFailureRecord[] {
    const text = raw.replace(ANSI, '').replaceAll('\\', '/')
    const lines = text.split(/\r?\n/)
    const found = new Map<string, TestFailureRecord>()
    const consumed = new Set<number>()
    for (let index = 0; index < lines.length; index += 1) {
      if (consumed.has(index)) continue
      const line = lines[index]!.trim()
      const fail = line.match(/^FAIL\s+(.+?)(?:\s+\[.*)?$/)
      const importFailure = line.match(/^(?:Error:\s*)?Failed to resolve import\s+["']([^"']+)["']\s+from\s+["']([^"']+)["']/i)
      const generic = line.match(/^(TypeError|ReferenceError|AssertionError|Error):\s+(.+)$/)
      if (!fail && !importFailure && !generic) continue
      let suite = fail?.[1]?.trim() ?? ''
      let testCase: string | undefined
      let errorType = generic?.[1] ?? (importFailure ? 'ImportResolutionError' : 'TestFailure')
      let message = generic?.[2] ?? (importFailure ? `Failed to resolve import ${importFailure[1]}` : 'Test suite failed')
      let sourceFile = importFailure?.[2]
      if (fail) {
        const parts = fail[1]!.split(' > ')
        suite = parts.shift()!.trim()
        testCase = parts.join(' > ').trim() || undefined
        for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor += 1) {
          const candidate = lines[cursor]!.trim()
          const error = candidate.match(/^(TypeError|ReferenceError|AssertionError|Error):\s+(.+)$/)
          if (error) { errorType = error[1]!; message = error[2]!; consumed.add(cursor); break }
        }
      }
      if (!suite) suite = importFailure ? this.normalizePath(importFailure[2]!) : 'test-setup'
      if (suite === 'test-setup' && generic) errorType = 'SetupFailure'
      const normalizedSuite = this.normalizePath(suite)
      const normalizedMessage = this.normalizeMessage(message)
      const signature = [normalizedSuite, testCase ?? '', errorType, normalizedMessage, sourceFile ? this.normalizePath(sourceFile) : ''].join('|')
      const fingerprint = createHash('sha256').update(signature).digest('hex')
      const existing = found.get(fingerprint)
      if (existing) { existing.occurrenceCount += 1; continue }
      found.set(fingerprint, {
        fingerprint, suite: normalizedSuite || sourceFile || 'unknown', ...(testCase ? { testCase } : {}),
        errorType, normalizedMessage, ...(sourceFile ? { sourceFile: this.normalizePath(sourceFile) } : {}),
        rawExcerpt: lines.slice(index, index + 8).join('\n').slice(0, 4000), occurrenceCount: 1, classification: 'unclassified',
      })
    }
    if (found.size === 0 && /command failed|npm error|cannot find module/i.test(text)) {
      const message = this.normalizeMessage(lines.find(line => /command failed|npm error|cannot find module/i.test(line)) ?? 'Test command failed')
      const fingerprint = createHash('sha256').update(`setup|${message}`).digest('hex')
      found.set(fingerprint, { fingerprint, suite: 'test-setup', errorType: 'SetupFailure', normalizedMessage: message, rawExcerpt: text.slice(-4000), occurrenceCount: 1, classification: 'unclassified' })
    }
    return [...found.values()]
  }

  private async environment(workspace: string, buildCommand: string, testCommand: string) {
    let lockfileHash: string | null = null
    for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      try {
        lockfileHash = createHash('sha256').update(await readFile(resolve(workspace, name))).digest('hex')
        break
      } catch {}
    }
    let containerIdentity = process.env.HOSTNAME ?? null
    try {
      const cgroup = await readFile('/proc/self/cgroup', 'utf8')
      containerIdentity = cgroup.trim().split('\n').map(line => line.split('/').at(-1)).find(Boolean) ?? containerIdentity
    } catch {}
    const safeEnvironment = Object.fromEntries(
      ['CI', 'NODE_ENV', 'TZ', 'LANG'].map(key => [key, process.env[key] ?? null]),
    )
    const evidence = {
      nodeVersion: process.version, platform: process.platform, architecture: process.arch,
      containerIdentity, lockfileHash, buildCommand, testCommand, safeEnvironment,
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
    return { fingerprint, lockfileHash, evidence }
  }

  private async confirmFailures(input: TestGateInput): Promise<TestFailureRecord[]> {
    try {
      const result = await execAsync(input.testCommand, { cwd: input.workspacePath, timeout: 300_000, maxBuffer: 30 * 1024 * 1024 })
      return this.parseFailures(`${result.stdout}\n${result.stderr}`)
    } catch (error: any) {
      return this.parseFailures(`${String(error?.stdout ?? '')}\n${String(error?.stderr ?? error?.message ?? '')}`)
    }
  }

  private normalizePath(value: string): string {
    return value.replace(/\/data\/workspace\/projects\/agentes\/[^/]+\/worktrees\/[^/]+\/[^/]+\/[^/]+\//g, '').replace(/^.*?(?=(?:apps|projects|packages|tests|database)\/)/, '')
  }

  private normalizeMessage(value: string): string {
    return this.normalizePath(value.replace(ANSI, '').replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '<duration>').replace(/\b(?:pid|port|id)\s*[=:]?\s*\d+\b/gi, '$1=<value>').trim()).slice(0, 2000)
  }

  private summary(text: string): { passed: number | null; failed: number | null } {
    const clean = text.replace(ANSI, '')
    const line = clean.match(/Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/i)
    return { failed: line?.[1] ? Number(line[1]) : null, passed: line?.[2] ? Number(line[2]) : null }
  }

  private async insertFailure(runId: number, failure: TestFailureRecord): Promise<void> {
    await this.pool.execute(
      `INSERT INTO test_failures
        (test_run_id, fingerprint_version, fingerprint, suite, test_case, error_type,
         normalized_message, source_file, source_line, raw_excerpt, occurrence_count, classification)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, failure.fingerprint, failure.suite, failure.testCase ?? null, failure.errorType ?? null,
        failure.normalizedMessage, failure.sourceFile ?? null, failure.sourceLine ?? null,
        failure.rawExcerpt, failure.occurrenceCount, failure.classification],
    )
  }

  private summaryLog(value: string): string { return value.slice(-20_000) }

  private async persistArtifacts(runId: number, stdout: string, stderr: string): Promise<{ stdout: string; stderr: string }> {
    const root = process.env.MOTOR_TEST_ARTIFACTS_DIR || '/data/workspace/projects/agentes/gerenteagentes/artifacts/test-runs'
    const directory = resolve(root, String(runId))
    await mkdir(directory, { recursive: true })
    const stdoutPath = resolve(directory, 'stdout.log.gz')
    const stderrPath = resolve(directory, 'stderr.log.gz')
    await Promise.all([
      writeFile(stdoutPath, await gzipAsync(Buffer.from(stdout))),
      writeFile(stderrPath, await gzipAsync(Buffer.from(stderr))),
    ])
    return { stdout: stdoutPath, stderr: stderrPath }
  }
}

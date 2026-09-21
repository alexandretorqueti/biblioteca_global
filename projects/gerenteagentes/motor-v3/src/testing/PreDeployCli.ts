import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { createQueueMessage } from '../queue/index.js'
import { TestGateOrchestrator } from './TestGateOrchestrator.js'

interface Input {
  projectId: number
  taskDatabaseId: number
  taskId: string
  repoPath: string
  branchName: string
  expectedCommit: string
  buildCommand: string
  testCommand: string
}

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? '{}') as Input
  if (!input.projectId || !input.taskDatabaseId || !input.repoPath || !input.expectedCommit || !input.buildCommand || !input.testCommand) {
    throw new Error('Entrada incompleta para gate pre_deploy')
  }
  const actualCommit = execFileSync('git', ['-C', input.repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (actualCommit !== input.expectedCommit) {
    throw new Error(`Commit mudou antes do pre_deploy: esperado ${input.expectedCommit}, atual ${actualCommit}`)
  }
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
    connectionLimit: 2,
  })
  try {
    const source = createQueueMessage({ type: 'PRE_DEPLOY_GATE_REQUESTED', taskId: input.taskId, executionId: `pre-deploy-${input.taskId}-${Date.now()}`, payload: { expectedCommit: actualCommit } })
    await pool.query(
      `INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
       VALUES (?,?,'motor.commands',?,?,?,NOW(),NULL,NULL,'pending',0)`,
      [source.messageId, source.type, source.taskId, source.executionId, JSON.stringify(source.payload)],
    )
    await pool.query(
      `INSERT INTO motor_operation_log (operation_id,sequence,phase,outcome,message_id,message_type,tarefa_id,input_json)
       VALUES (?,1,'received','executed',?,?,?,?)`,
      [source.messageId, source.messageId, source.type, input.taskId, JSON.stringify(source.payload)],
    )
    const gate = await new TestGateOrchestrator(pool).request({
      projectId: input.projectId, taskDatabaseId: input.taskDatabaseId, phase: 'pre_deploy',
      commitSha: actualCommit, baseCommitSha: actualCommit, branchName: input.branchName,
      workspacePath: input.repoPath, buildCommand: input.buildCommand, testCommand: input.testCommand,
    }, source)
    process.stdout.write(JSON.stringify({ id: gate.id, status: gate.status, failureCount: gate.failures.length, commitSha: actualCommit }))
    if (gate.status !== 'passed' || gate.failures.length > 0) process.exitCode = 2
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

/**
 * Registry de todas as primitivas do motor-v3
 * 
 * As primitivas são operações atômicas que o motor pode executar.
 * Elas são combinadas em ações (definidas no catálogo) para formar
 * reações a eventos.
 */

import type { PrimitiveDefinition } from './types.js'

// Importa primitivas por domínio
import { setFlag, log } from './control.js'
import { createSession, archiveSession, incrementGeneration, sendMessage, sendFeedback, waitForCompletion, parseReply } from './session.js'
import { cooldownModel, escalateModel } from './model.js'
import { createWorktree, removeWorktree, installDependencies, verifyGit, runBuild, commitChanges, mergeBranch, revertMerge, publishBranch, promoteToBase, checkPaths } from './git.js'
import { persistPlan, createSubtasks, checkCommits, blockTask, blockSubtask, persistBlocker, unblockSubtask } from './db.js'
import { pauseAgentQueue, resumeAgentQueue, enqueueDeploy } from './queue.js'

/**
 * Lista completa de todas as 32 primitivas
 */
export const ALL_PRIMITIVES: PrimitiveDefinition[] = [
  // Controle (2)
  setFlag,
  log,
  
  // Sessão (7)
  createSession,
  archiveSession,
  incrementGeneration,
  sendMessage,
  sendFeedback,
  waitForCompletion,
  parseReply,
  
  // Modelo (2)
  cooldownModel,
  escalateModel,
  
  // Git (11)
  createWorktree,
  removeWorktree,
  installDependencies,
  verifyGit,
  runBuild,
  commitChanges,
  mergeBranch,
  revertMerge,
  publishBranch,
  promoteToBase,
  checkPaths,
  
  // Banco (7)
  persistPlan,
  createSubtasks,
  checkCommits,
  blockTask,
  blockSubtask,
  persistBlocker,
  unblockSubtask,
  
  // Fila (3)
  pauseAgentQueue,
  resumeAgentQueue,
  enqueueDeploy,
]

/**
 * Busca primitiva por código
 */
export function getPrimitiveByCode(code: string): PrimitiveDefinition | undefined {
  return ALL_PRIMITIVES.find(p => p.code === code)
}

/**
 * Registra todas as primitivas no ActionExecutor
 */
export function registerAllPrimitives(executor: any): void {
  for (const primitive of ALL_PRIMITIVES) {
    executor.registerPrimitive(primitive.code, primitive.handler)
  }
}

// Exporta tipos
export * from './types.js'

// Exporta primitivas individuais para uso direto se necessário
export * from './control.js'
export * from './session.js'
export * from './model.js'
export * from './git.js'
export * from './db.js'
export * from './queue.js'

/**
 * Motor v2 - Exports principais
 */

// Types
export type {
  Task,
  SubTask,
  Project,
  ModelConfig,
  ModelChain,
  TaskStatus,
  SubTaskStatus,
  ExecutionPhase,
} from './shared/types/index.js'

export type {
  ExecutionContext,
  ExecutionResult,
  WorkerInput,
  WorkerOutput,
  WorkerMessage,
  CoordinatorMessage,
} from './shared/types/execution.js'

export type {
  ResourceLease,
  AcquireResult,
  RenewResult,
  ReleaseResult,
  ResourceWaitEntry,
  ResourceKey,
} from './shared/types/resources.js'

export { RESOURCE_KEYS } from './shared/types/resources.js'
export { createExecutionContext } from './shared/types/execution.js'

// Execution
export { executionContextManager, getCurrentContext, requireCurrentContext } from './execution/ExecutionContextManager.js'

// Resources
export { ResourceLeaseService } from './resources/ResourceLeaseService.js'
export type { ResourceLeaseServiceConfig } from './resources/ResourceLeaseService.js'
export { ResourceEventBus, resourceEventBus } from './resources/ResourceEventBus.js'
export type { ResourceEvent, ResourceEventHandler, ResourceEventType } from './resources/ResourceEventBus.js'
export { ResourceWaitManager } from './resources/ResourceWaitManager.js'

// Coordinator
export { TaskCoordinator } from './coordinator/TaskCoordinator.js'
export type { TaskCoordinatorConfig } from './coordinator/TaskCoordinator.js'

// Workers
export { WorkerLauncher } from './workers/WorkerLauncher.js'
export type { WorkerEventHandler } from './workers/WorkerLauncher.js'

/**
 * Motor v2 - Exports públicos
 */

// Main
export { Motor } from './Motor.js'
export type { MotorConfig } from './Motor.js'

// Coordinator
export { TaskCoordinator } from './coordinator/TaskCoordinator.js'
export type { TaskCoordinatorConfig } from './coordinator/TaskCoordinator.js'

// Workers
export { WorkerLauncher } from './workers/WorkerLauncher.js'
export { TaskWorker } from './workers/TaskWorker.js'
export type { WorkerEvent } from './workers/WorkerLauncher.js'
export type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from './workers/WorkerProtocol.js'

// Resources
export { ResourceLeaseService } from './resources/ResourceLeaseService.js'
export type { ResourceLeaseServiceConfig } from './resources/ResourceLeaseService.js'
export { ResourceEventBus, resourceEventBus } from './resources/ResourceEventBus.js'
export type { ResourceEvent, ResourceEventHandler, ResourceEventType } from './resources/ResourceEventBus.js'
export { ResourceWaitManager } from './resources/ResourceWaitManager.js'
export { ExecutionEventBus, executionEventBus } from './events/ExecutionEventBus.js'
export type { ExecutionActivityEvent, ExecutionActivityBroadcaster } from './events/ExecutionEventBus.js'

// Execution
export { executionContextManager, getCurrentContext, requireCurrentContext } from './execution/ExecutionContextManager.js'

// Reconciler
export { ExpirationReconciler } from './reconciler/ExpirationReconciler.js'
export type { ExpirationReconcilerConfig } from './reconciler/ExpirationReconciler.js'

// API
export { MotorAPI } from './api/MotorAPI.js'
export type { MotorAPIConfig } from './api/MotorAPI.js'

// Types
export type {
  Task,
  SubTask,
  Project,
  ModelConfig,
  ModelChain,
  TaskStatus,
  SubTaskStatus,
} from './shared/types/index.js'

export type {
  ExecutionContext,
  ExecutionPhase,
  ExecutionResult,
  WorkerInput,
  WorkerOutput,
} from './shared/types/execution.js'

export type {
  ResourceLease,
  AcquireResult,
  ResourceKey,
} from './shared/types/resources.js'

export { RESOURCE_KEYS } from './shared/types/resources.js'

export type { Db, TaskRepository, QueryResult, SaveTaskData, TaskRow } from './shared/types/infrastructure.js'
export type { AgentRuntimeDriver, SendMessageResult, RunStatusResult, SendMessageParams } from './shared/types/agent-runtime.js'

// Steps
export { MotorMonitorStep } from './steps/MotorMonitorStep.js'
export type { MotorFixInput, MotorFixResult, MotorMonitorStepConfig } from './steps/MotorMonitorStep.js'

/**
 * Tipos de recursos e leases
 */

export interface ResourceLease {
  resourceKey: string
  executionId: string
  ownerId: string
  fencingToken: number
  heartbeatAt: Date
  acquiredAt: Date
  expiresAt: Date
}

export type AcquireResult =
  | { kind: 'acquired'; lease: ResourceLease }
  | { kind: 'waiting'; waitId: number; position: number }
  | { kind: 'denied'; reason: string }

export type RenewResult =
  | { kind: 'renewed'; lease: ResourceLease }
  | { kind: 'lost'; reason: string }

export type ReleaseResult =
  | { kind: 'released' }
  | { kind: 'not_owner' }

export interface ResourceWaitEntry {
  id: number
  resourceKey: string
  executionId: string
  ownerId: string
  requestedAt: Date
  status: 'waiting' | 'granted' | 'expired'
}

export type ResourceKey =
  | `project:${string}:execution`
  | `project:${string}:integration`
  | `project:${string}:deploy`
  | `subtask:${string}`
  | 'gpu:local-model'
  | 'motor:monitor'
  | 'infra:mysql:3308'
  | 'infra:port:3003'
  | 'infra:port:5174'

export const RESOURCE_KEYS = {
  projectExecution: (slug: string): ResourceKey => `project:${slug}:execution`,
  projectIntegration: (slug: string): ResourceKey => `project:${slug}:integration`,
  projectDeploy: (slug: string): ResourceKey => `project:${slug}:deploy`,
  subtask: (id: string): ResourceKey => `subtask:${id}`,
  gpuLocalModel: (): ResourceKey => 'gpu:local-model',
  motorMonitor: (): ResourceKey => 'motor:monitor',
  infraMysql3308: (): ResourceKey => 'infra:mysql:3308',
  infraPort3003: (): ResourceKey => 'infra:port:3003',
  infraPort5174: (): ResourceKey => 'infra:port:5174',
} as const

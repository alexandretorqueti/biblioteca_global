import { createHash } from "node:crypto"

export function promotionConflictFingerprint(input: {
  taskId: string
  baseCommit: string
  taskCommit: string
  conflictFiles: readonly string[]
}): string {
  return createHash("sha256")
    .update([input.taskId, input.baseCommit, input.taskCommit, ...[...input.conflictFiles].sort()].join("\0"))
    .digest("hex")
}


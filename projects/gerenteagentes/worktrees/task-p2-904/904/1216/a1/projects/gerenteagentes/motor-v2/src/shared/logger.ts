/**
 * Logger estruturado do Motor v2
 *
 * Toda linha de log carrega timestamp ISO, nível, componente e contexto de
 * correlação (taskId/subtaskId/executionId/fase), em texto ou JSON por linha.
 *
 * Variáveis de ambiente:
 * - MOTOR_LOG_LEVEL:  debug | info | warn | error (padrão: info)
 * - MOTOR_LOG_FORMAT: text | json (padrão: text)
 * - MOTOR_LOG_FILE:   caminho de arquivo para espelhar o log (append)
 */

import { createWriteStream, type WriteStream } from "node:fs"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogContext {
  taskId?: string
  subtaskId?: number | string
  executionId?: string
  phase?: string
  [key: string]: unknown
}

export interface Logger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
  child(context: LogContext): Logger
}

function parseLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value
  return fallback
}

let configuredLevel: LogLevel = parseLevel(process.env.MOTOR_LOG_LEVEL)
let fileStream: WriteStream | null = null

export function setLogLevel(level: LogLevel): void {
  configuredLevel = level
}

export function getLogLevel(): LogLevel {
  return configuredLevel
}

function ensureFileStream(): WriteStream | null {
  const file = process.env.MOTOR_LOG_FILE
  if (!file) return null
  if (!fileStream) {
    fileStream = createWriteStream(file, { flags: "a" })
    fileStream.on("error", () => {
      fileStream = null
    })
  }
  return fileStream
}

function formatContext(context: LogContext): string {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
}

function emit(level: LogLevel, component: string, message: string, context: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return
  const timestamp = new Date().toISOString()
  let line: string
  if (process.env.MOTOR_LOG_FORMAT === "json") {
    const cleanContext = Object.fromEntries(
      Object.entries(context).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    )
    line = JSON.stringify({ timestamp, level, component, message, ...cleanContext })
  } else {
    const ctx = formatContext(context)
    line = `${timestamp} ${level.toUpperCase().padEnd(5)} [${component}]${ctx ? " " + ctx : ""} ${message}`
  }
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log
  writer(line)
  const stream = ensureFileStream()
  if (stream) stream.write(line + "\n")
}

export function createLogger(component: string, baseContext: LogContext = {}): Logger {
  const write = (level: LogLevel) => (message: string, context: LogContext = {}) =>
    emit(level, component, message, { ...baseContext, ...context })
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child(context: LogContext): Logger {
      return createLogger(component, { ...baseContext, ...context })
    },
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

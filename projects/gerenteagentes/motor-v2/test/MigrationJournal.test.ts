import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const migrationDir = join(process.cwd(), "../migrations")
const journalPath = join(migrationDir, "meta/_journal.json")

describe("journal de migrations do GerenteAgentes", () => {
  it("registra todas as migrations SQL existentes", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag?: string }> }
    const tags = new Set(journal.entries.map((entry) => entry.tag).filter((tag): tag is string => Boolean(tag)))
    const files = readdirSync(migrationDir)
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
      .map((file) => file.slice(0, -4))

    expect(files).not.toHaveLength(0)
    expect(files.filter((file) => !tags.has(file))).toEqual([])
  })
})

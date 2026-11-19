// @vitest-environment node

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const alphaCss = readFileSync(resolve(process.cwd(), "projects/chat-universal/src/AlphaChat.css"), "utf8")

describe("AlphaChat.css tenant scoping", () => {
  it("keeps Alpha global layout rules qualified by tenant-alpha", () => {
    expect(alphaCss).toContain("html.tenant-alpha, body.tenant-alpha")
    expect(alphaCss).toContain("body.tenant-alpha #root")
    expect(alphaCss).not.toMatch(/^\s*html\s*,\s*body\s*\{/m)
    expect(alphaCss).not.toMatch(/^\s*#root\s*\{/m)
    expect(alphaCss).not.toMatch(/^\s*body\s*\{/m)
  })
})

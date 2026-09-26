import { describe, expect, it } from "vitest"
import {
  createFlexBasis,
  createGridSpan,
  createGridTemplateColumns,
} from "../layout"

describe("layout utilities", () => {
  it("creates fixed grid columns", () => {
    expect(createGridTemplateColumns(3)).toBe(
      "repeat(3, minmax(0, 1fr))",
    )
  })

  it("creates responsive grid columns", () => {
    expect(
      createGridTemplateColumns({ xs: 1, md: 3 }),
    ).toEqual({
      xs: "repeat(1, minmax(0, 1fr))",
      md: "repeat(3, minmax(0, 1fr))",
    })
  })

  it("creates automatic columns using a minimum width", () => {
    expect(createGridTemplateColumns(1, 280)).toBe(
      "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
    )
  })

  it("creates flex basis and grid spans", () => {
    expect(createFlexBasis({ xs: 1, md: 4 })).toEqual({
      xs: "100%",
      md: "calc((100% - 3 * var(--layout-column-gap, 0px)) / 4)",
    })

    expect(createGridSpan({ xs: 1, md: 2 })).toEqual({
      xs: "span 1",
      md: "span 2",
    })
  })

  it("normalizes invalid column values", () => {
    expect(createGridTemplateColumns(0)).toBe(
      "repeat(1, minmax(0, 1fr))",
    )
    expect(createGridSpan(0)).toBe("span 1")
  })
})

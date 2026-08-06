import { describe, expect, it } from "vitest"
import { normalizeNotebookOutput, parseNotebook } from "./notebook"

describe("notebook parsing", () => {
  it("parses cells and array sources", () => {
    const result = parseNotebook(JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1\n"] }] }))
    expect("error" in result).toBe(false)
    if (!("error" in result)) expect(result.cells[0].source).toBe("x = 1\n")
  })

  it("normalizes text, errors, and images", () => {
    expect(normalizeNotebookOutput({ output_type: "stream", text: ["hello", "\n"] })).toMatchObject({ kind: "text", text: "hello\n" })
    expect(normalizeNotebookOutput({ output_type: "error", ename: "ValueError", evalue: "bad" })).toMatchObject({ kind: "error" })
    expect(normalizeNotebookOutput({ output_type: "display_data", data: { "image/png": "aGVsbG8=" } })).toMatchObject({ kind: "image", dataUrl: "data:image/png;base64,aGVsbG8=" })
  })

  it("rejects invalid roots and keeps unknown cells", () => {
    expect(parseNotebook("not json")).toEqual({ error: "invalidJson" })
    const result = parseNotebook(JSON.stringify({ cells: [{ cell_type: "future", source: "x" }] }))
    expect("error" in result ? result.error : result.cells[0].type).toBe("unknown")
  })
})

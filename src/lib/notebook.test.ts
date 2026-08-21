import { describe, expect, it } from "vitest"
import {
  appendNotebookCellOutput,
  deleteNotebookCell,
  insertNotebookCell,
  normalizeNotebookOutput,
  parseNotebook,
  replaceNotebookCellOutputs,
  setNotebookCellSource,
  setNotebookExecutionCount,
} from "./notebook"

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

  it("preserves unknown notebook data while changing a cell source", () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { custom: { keep: true } },
      cells: [
        {
          cell_type: "code",
          source: ["old\n"],
          metadata: { tags: ["keep"] },
          outputs: [],
          execution_count: null,
          custom: { keep: true },
        },
      ],
    })

    const result = setNotebookCellSource(content, 0, "new\nvalue")
    const root = JSON.parse(result)

    expect(root.metadata).toEqual({ custom: { keep: true } })
    expect(root.cells[0]).toMatchObject({
      source: ["new\n", "value"],
      metadata: { tags: ["keep"] },
      custom: { keep: true },
    })
  })

  it("adds and deletes cells without changing existing cells", () => {
    const content = JSON.stringify({
      cells: [
        {
          cell_type: "markdown",
          source: ["# Existing"],
          metadata: { keep: true },
          attachment: { x: 1 },
        },
      ],
    })

    const withCode = insertNotebookCell(content, 1, "code")
    const withMarkdown = insertNotebookCell(withCode, 1, "markdown")
    const result = JSON.parse(deleteNotebookCell(withMarkdown, 1))

    expect(result.cells).toHaveLength(2)
    expect(result.cells[0]).toMatchObject({
      cell_type: "markdown",
      metadata: { keep: true },
      attachment: { x: 1 },
    })
    expect(result.cells[1]).toEqual({
      cell_type: "code",
      metadata: {},
      source: [],
      execution_count: null,
      outputs: [],
    })
  })

  it("replaces and appends only target cell outputs", () => {
    const content = JSON.stringify({
      cells: [
        { cell_type: "code", source: "first", outputs: [{ output_type: "stream", text: "keep" }] },
        { cell_type: "code", source: "second", outputs: [{ output_type: "stream", text: "old" }] },
      ],
    })
    const output = {
      output_type: "display_data",
      data: { "text/html": ["<table><tr><td>PBCASH</td></tr></table>"] },
      metadata: { isolated: true },
    }

    const replaced = replaceNotebookCellOutputs(content, 1, [output])
    const appended = appendNotebookCellOutput(replaced, 1, {
      output_type: "stream",
      name: "stdout",
      text: "done\n",
    })
    const result = JSON.parse(setNotebookExecutionCount(appended, 1, 79))

    expect(result.cells[0].outputs).toEqual([{ output_type: "stream", text: "keep" }])
    expect(result.cells[1].execution_count).toBe(79)
    expect(result.cells[1].outputs).toEqual([output, { output_type: "stream", name: "stdout", text: "done\n" }])
    expect(parseNotebook(JSON.stringify(result)).cells[1].outputs[0]).toMatchObject({
      kind: "html",
      text: "<table><tr><td>PBCASH</td></tr></table>",
    })
  })
})

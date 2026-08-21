export interface NotebookOutput {
  kind: "text" | "error" | "image" | "json" | "html"
  text?: string
  mime?: string
  dataUrl?: string
}

export interface NotebookCell {
  type: "markdown" | "code" | "raw" | "unknown"
  source: string
  executionCount: number | null
  language: string
  outputs: NotebookOutput[]
}

export interface NotebookDocument {
  cells: NotebookCell[]
  language: string
  kernel: string
}

export type NotebookParseError = "invalidJson" | "invalidRoot" | "invalidCells"
export type NotebookEditableCellType = "markdown" | "code"

type NotebookRoot = Record<string, unknown> & { cells: unknown[] }

export class NotebookMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotebookMutationError"
  }
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("")
  return typeof value === "string" ? value : ""
}

function mimeText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return textValue(value)
  if (value == null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseNotebookRoot(content: string): NotebookRoot {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new NotebookMutationError("Notebook contains invalid JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotebookMutationError("Notebook has an invalid root")
  }
  const root = value as Record<string, unknown>
  if (!Array.isArray(root.cells)) {
    throw new NotebookMutationError("Notebook has an invalid cells list")
  }
  return root as NotebookRoot
}

function notebookCellAt(root: NotebookRoot, index: number): Record<string, unknown> {
  if (!Number.isInteger(index) || index < 0 || index >= root.cells.length) {
    throw new NotebookMutationError("Notebook cell index is out of range")
  }
  const cell = root.cells[index]
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
    throw new NotebookMutationError("Notebook cell is invalid")
  }
  return cell as Record<string, unknown>
}

function sourceLines(source: string): string[] {
  return source === "" ? [] : source.split(/(?<=\n)/)
}

function serializeNotebook(root: NotebookRoot): string {
  return `${JSON.stringify(root, null, 2)}\n`
}

export function mutateNotebook(
  content: string,
  mutation: (root: NotebookRoot) => void
): string {
  const root = parseNotebookRoot(content)
  mutation(root)
  return serializeNotebook(root)
}

export function setNotebookCellSource(
  content: string,
  index: number,
  source: string
): string {
  return mutateNotebook(content, (root) => {
    notebookCellAt(root, index).source = sourceLines(source)
  })
}

export function insertNotebookCell(
  content: string,
  index: number,
  type: NotebookEditableCellType
): string {
  return mutateNotebook(content, (root) => {
    if (!Number.isInteger(index) || index < 0 || index > root.cells.length) {
      throw new NotebookMutationError("Notebook cell index is out of range")
    }
    const cell: Record<string, unknown> = {
      cell_type: type,
      metadata: {},
      source: [],
    }
    if (type === "code") {
      cell.execution_count = null
      cell.outputs = []
    }
    root.cells.splice(index, 0, cell)
  })
}

export function deleteNotebookCell(content: string, index: number): string {
  return mutateNotebook(content, (root) => {
    notebookCellAt(root, index)
    root.cells.splice(index, 1)
  })
}

export function replaceNotebookCellOutputs(
  content: string,
  index: number,
  outputs: unknown[]
): string {
  return mutateNotebook(content, (root) => {
    notebookCellAt(root, index).outputs = outputs
  })
}

export function appendNotebookCellOutput(
  content: string,
  index: number,
  output: unknown
): string {
  return mutateNotebook(content, (root) => {
    const cell = notebookCellAt(root, index)
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : []
    cell.outputs = [...outputs, output]
  })
}

export function setNotebookExecutionCount(
  content: string,
  index: number,
  count: number | null
): string {
  return mutateNotebook(content, (root) => {
    notebookCellAt(root, index).execution_count = count
  })
}

export function normalizeNotebookOutput(output: unknown): NotebookOutput | null {
  if (!output || typeof output !== "object") return null
  const item = output as Record<string, unknown>
  const outputType = typeof item.output_type === "string" ? item.output_type : ""

  if (outputType === "error") {
    const traceback = textValue(item.traceback)
    const message = [item.ename, item.evalue].filter((v) => typeof v === "string").join(": ")
    return { kind: "error", text: traceback || message || "Execution error" }
  }

  if (outputType === "stream") {
    return { kind: "text", text: textValue(item.text) }
  }

  const data = item.data
  if (!data || typeof data !== "object") return null
  const bundle = data as Record<string, unknown>
  const image = ["image/png", "image/jpeg", "image/svg+xml"].find(
    (mime) => typeof bundle[mime] === "string" || Array.isArray(bundle[mime])
  )
  if (image) {
    const raw = mimeText(bundle[image])
    const dataUrl =
      image === "image/svg+xml"
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`
        : `data:${image};base64,${raw.replace(/\s/g, "")}`
    return {
      kind: "image",
      mime: image,
      dataUrl,
    }
  }
  if (typeof bundle["text/html"] === "string" || Array.isArray(bundle["text/html"])) {
    return { kind: "html", mime: "text/html", text: mimeText(bundle["text/html"]) }
  }
  const json = bundle["application/json"]
  if (json !== undefined) return { kind: "json", mime: "application/json", text: mimeText(json) }
  if (bundle["text/plain"] !== undefined) return { kind: "text", text: mimeText(bundle["text/plain"]) }
  return null
}

export function parseNotebook(
  content: string
): NotebookDocument | { error: NotebookParseError } {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return { error: "invalidJson" }
  }
  if (!value || typeof value !== "object") return { error: "invalidRoot" }
  const root = value as Record<string, unknown>
  if (!Array.isArray(root.cells)) return { error: "invalidCells" }
  const metadata = (root.metadata ?? {}) as Record<string, unknown>
  const kernelspec = (metadata.kernelspec ?? {}) as Record<string, unknown>
  const languageInfo = (metadata.language_info ?? {}) as Record<string, unknown>
  const language = String(languageInfo.name ?? kernelspec.language ?? "")
  const kernel = String(kernelspec.display_name ?? kernelspec.name ?? "")

  return {
    language,
    kernel,
    cells: root.cells.map((raw): NotebookCell => {
      const cell = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
      const type = cell.cell_type
      const normalizedType = type === "markdown" || type === "code" || type === "raw" ? type : "unknown"
      const metadata = (cell.metadata ?? {}) as Record<string, unknown>
      const cellLanguage = (metadata.language ?? language) as string
      const executionCount = typeof cell.execution_count === "number" ? cell.execution_count : null
      const outputs = Array.isArray(cell.outputs)
        ? cell.outputs.map(normalizeNotebookOutput).filter((output): output is NotebookOutput => output !== null)
        : []
      return {
        type: normalizedType,
        source: textValue(cell.source),
        executionCount,
        language: cellLanguage || "python",
        outputs,
      }
    }),
  }
}

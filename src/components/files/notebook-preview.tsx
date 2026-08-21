"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  CircleStop,
  LoaderCircle,
  Play,
  Plus,
  Power,
  RotateCcw,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Streamdown } from "streamdown"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import {
  notebookKernelExecute,
  notebookKernelInterrupt,
  notebookKernelListSpecs,
  notebookKernelRestart,
  notebookKernelRunAll,
  notebookKernelShutdown,
  notebookKernelStart,
} from "@/lib/api"
import { splitAbsPath } from "@/lib/file-open-target"
import {
  deleteNotebookCell,
  insertNotebookCell,
  parseNotebook,
  setNotebookCellSource,
  type NotebookCell,
  type NotebookOutput,
  type NotebookParseError,
} from "@/lib/notebook"
import { subscribe } from "@/lib/platform"
import type {
  NotebookKernelEvent,
  NotebookKernelSpec,
  NotebookKernelState,
} from "@/lib/types"
import { useStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"

const NOTEBOOK_KERNEL_EVENT = "notebook-kernel://event"

function CellMarkdown({ source }: { source: string }) {
  const plugins = useStreamdownPlugins(source)
  return <Streamdown plugins={plugins}>{source}</Streamdown>
}

function Output({ output }: { output: NotebookOutput }) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  if (output.kind === "image" && output.dataUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={output.dataUrl}
        alt="Notebook output"
        className="max-w-full border border-border"
      />
    )
  }
  if (output.kind === "html" && output.text) {
    return (
      <iframe
        title={t("notebookHtmlOutput")}
        sandbox=""
        srcDoc={output.text}
        className="min-h-12 w-full border border-border bg-white"
      />
    )
  }
  return (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap border border-border/70 p-3 text-xs ${
        output.kind === "error"
          ? "bg-red-500/10 text-red-700 dark:text-red-300"
          : "bg-muted/40 text-foreground/85"
      }`}
    >
      {output.text ?? ""}
    </pre>
  )
}

type NotebookMessage =
  | "notebookCell"
  | "notebookCells"
  | "notebookEmptyCell"
  | "notebookEmpty"
  | "notebookInvalidJson"
  | "notebookInvalidRoot"
  | "notebookInvalidCells"
  | "notebookAddCodeCell"
  | "notebookAddMarkdownCell"
  | "notebookDeleteCell"
  | "notebookRunCell"
  | "notebookRunAll"
  | "notebookInterrupt"
  | "notebookRestart"
  | "notebookShutdown"
  | "notebookKernel"
  | "notebookSelectKernel"
  | "notebookRunning"
  | "notebookKernelUnavailable"
  | "notebookInputPrompt"
  | "notebookHtmlOutput"

type NotebookTranslator = (
  key: NotebookMessage,
  values?: { count?: number }
) => string

function iconButtonClass(destructive = false) {
  return `flex size-7 shrink-0 items-center justify-center border border-transparent transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 ${
    destructive ? "hover:text-destructive" : ""
  }`
}

function Cell({
  cell,
  index,
  editingMarkdown,
  busy,
  readOnly,
  t,
  onChange,
  onEditMarkdown,
  onRun,
  onDelete,
}: {
  cell: NotebookCell
  index: number
  editingMarkdown: boolean
  busy: boolean
  readOnly: boolean
  t: NotebookTranslator
  onChange: (value: string) => void
  onEditMarkdown: () => void
  onRun: () => void
  onDelete: () => void
}) {
  return (
    <article className="border border-border/70 bg-background">
      <div className="flex h-9 items-center gap-2 border-b border-border/60 px-2 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {t("notebookCell", { count: index + 1 })}
        </span>
        <span className="font-mono">{cell.type}</span>
        {cell.type === "code" && (
          <span className="font-mono">{cell.language}</span>
        )}
        {cell.type === "code" && cell.executionCount !== null && (
          <span className="ml-auto font-mono">[{cell.executionCount}]</span>
        )}
        {cell.type === "code" && (
          <button
            type="button"
            onClick={onRun}
            disabled={busy}
            className={iconButtonClass()}
            aria-label={t("notebookRunCell", { count: index + 1 })}
            title={t("notebookRunCell", { count: index + 1 })}
          >
            <Play className="size-3.5" />
          </button>
        )}
        {(cell.type === "code" || cell.type === "markdown") && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className={iconButtonClass(true)}
            aria-label={t("notebookDeleteCell", { count: index + 1 })}
            title={t("notebookDeleteCell", { count: index + 1 })}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      <div className="p-3">
        {cell.type === "markdown" ? (
          editingMarkdown ? (
            <Textarea
              value={cell.source}
              onChange={(event) => onChange(event.target.value)}
              onBlur={onEditMarkdown}
              disabled={readOnly}
              aria-label={t("notebookCell", { count: index + 1 })}
              className="min-h-28 rounded-none font-mono text-xs leading-5"
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={readOnly ? undefined : onEditMarkdown}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  if (!readOnly) onEditMarkdown()
                }
              }}
              className="prose prose-sm dark:prose-invert max-w-none cursor-text"
            >
              <CellMarkdown source={cell.source || t("notebookEmptyCell")} />
            </div>
          )
        ) : cell.type === "code" ? (
          <Textarea
            value={cell.source}
            onChange={(event) => onChange(event.target.value)}
            disabled={readOnly}
            aria-label={t("notebookCell", { count: index + 1 })}
            className="min-h-28 rounded-none border-0 bg-muted/35 font-mono text-xs leading-5"
          />
        ) : (
          <pre className="overflow-x-auto bg-muted/50 p-3 text-xs leading-5">
            <code>{cell.source || t("notebookEmptyCell")}</code>
          </pre>
        )}
        {cell.outputs.length > 0 && (
          <div className="mt-3 space-y-2 border-l-2 border-primary/25 pl-3">
            {cell.outputs.map((output, outputIndex) => (
              <Output key={`${index}-${outputIndex}`} output={output} />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export function NotebookPreview({ tab }: { tab: FileWorkspaceTab }) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const { updateFileTabContent } = useWorkspaceActions()
  const contentRef = useRef(tab.content ?? "")
  const kernelStartedRef = useRef(false)
  const [kernelSpecs, setKernelSpecs] = useState<NotebookKernelSpec[]>([])
  const [kernelName, setKernelName] = useState<string | null>(null)
  const [kernelStarted, setKernelStarted] = useState(false)
  const [kernelState, setKernelState] = useState<NotebookKernelState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [editingMarkdown, setEditingMarkdown] = useState<number | null>(null)
  const parsed = useMemo(() => parseNotebook(tab.content ?? ""), [tab.content])
  const title = tab.title || tab.path?.split(/[\\/]/).pop() || "Notebook"
  const sessionId = tab.id
  const busy =
    kernelState === "busy" ||
    kernelState === "starting" ||
    kernelState === "interrupting"
  const readOnly = Boolean(tab.readonly)

  useEffect(() => {
    contentRef.current = tab.content ?? ""
  }, [tab.content])

  useEffect(() => {
    let disposed = false
    void notebookKernelListSpecs()
      .then((specs) => {
        if (!disposed) setKernelSpecs(specs)
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(String(reason))
      })
    return () => {
      disposed = true
    }
  }, [])

  const updateContent = useCallback(
    (mutate: (content: string) => string) => {
      try {
        const content = mutate(contentRef.current)
        contentRef.current = content
        updateFileTabContent(tab.id, content)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [tab.id, updateFileTabContent]
  )

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<NotebookKernelEvent>(NOTEBOOK_KERNEL_EVENT, (event) => {
      if (event.sessionId !== sessionId) return
      if (event.kind === "state") {
        setKernelState(event.state)
        if (event.state === "dead" || event.state === "unavailable") {
          kernelStartedRef.current = false
          setKernelStarted(false)
        }
        return
      }
      if (event.kind === "error") setError(event.message)
    })
      .then((cleanup) => {
        if (disposed) cleanup()
        else unsubscribe = cleanup
      })
      .catch((reason: unknown) => setError(String(reason)))
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [sessionId, t])

  const ensureKernel = useCallback(async () => {
    if (kernelStartedRef.current) return
    if (!tab.path) throw new Error(t("notebookKernelUnavailable"))
    const path = splitAbsPath(tab.path)
    if (!path) throw new Error(t("notebookKernelUnavailable"))
    setKernelState("starting")
    const session = await notebookKernelStart({
      sessionId,
      notebookPath: tab.path,
      cwd: path.rootPath,
      kernelName: (kernelName ?? parsed.kernelName) || undefined,
    })
    kernelStartedRef.current = true
    setKernelStarted(true)
    setKernelState(session.state)
  }, [kernelName, parsed.kernelName, sessionId, t, tab.path])

  const runCell = useCallback(
    async (index: number, code: string) => {
      setError(null)
      try {
        await ensureKernel()
        setKernelState("busy")
        await notebookKernelExecute({ sessionId, cellIndex: index, code })
      } catch (reason) {
        setKernelState("idle")
        setError(String(reason))
      }
    },
    [ensureKernel, sessionId]
  )

  const runAll = useCallback(async () => {
    if ("error" in parsed) return
    setError(null)
    try {
      await ensureKernel()
      setKernelState("busy")
      await notebookKernelRunAll({
        sessionId,
        cells: parsed.cells
          .map((cell, index) => ({ cell, index }))
          .filter(({ cell }) => cell.type === "code")
          .map(({ cell, index }) => ({ index, code: cell.source })),
      })
    } catch (reason) {
      setKernelState("idle")
      setError(String(reason))
    }
  }, [ensureKernel, parsed, sessionId])

  const interrupt = useCallback(async () => {
    try {
      await ensureKernel()
      setKernelState("interrupting")
      await notebookKernelInterrupt(sessionId)
    } catch (reason) {
      setError(String(reason))
    }
  }, [ensureKernel, sessionId])

  const restart = useCallback(async () => {
    try {
      await ensureKernel()
      setKernelState("starting")
      await notebookKernelRestart(sessionId)
    } catch (reason) {
      setError(String(reason))
    }
  }, [ensureKernel, sessionId])

  const shutdown = useCallback(async () => {
    if (!kernelStartedRef.current) return
    kernelStartedRef.current = false
    setKernelStarted(false)
    setKernelState("dead")
    try {
      await notebookKernelShutdown(sessionId)
    } catch (reason) {
      setError(String(reason))
    }
  }, [sessionId])

  if ("error" in parsed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {t(errorMessageKey(parsed.error))}
      </div>
    )
  }

  const selectedKernelName = kernelName ?? parsed.kernelName
  const selectedKernel =
    kernelSpecs.find((spec) => spec.name === selectedKernelName)?.displayName ||
    selectedKernelName ||
    parsed.kernel ||
    t("notebookSelectKernel")

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={title}
        >
          {title}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 max-w-44 items-center gap-1 border border-border px-2 text-xs hover:bg-muted"
              title={t("notebookSelectKernel")}
            >
              <span className="truncate">{selectedKernel}</span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {kernelSpecs.length === 0 ? (
              <DropdownMenuItem disabled>
                {t("notebookKernelUnavailable")}
              </DropdownMenuItem>
            ) : (
              kernelSpecs.map((spec) => (
                <DropdownMenuItem
                  key={spec.name}
                  onSelect={() => {
                    if (busy) return
                    void shutdown().then(() => setKernelName(spec.name))
                  }}
                >
                  {spec.displayName}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={busy || readOnly}
              className={iconButtonClass()}
              aria-label={t("notebookAddCodeCell")}
              title={t("notebookAddCodeCell")}
            >
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                updateContent((content) =>
                  insertNotebookCell(content, parsed.cells.length, "code")
                )
              }
            >
              {t("notebookAddCodeCell")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                updateContent((content) =>
                  insertNotebookCell(content, parsed.cells.length, "markdown")
                )
              }
            >
              {t("notebookAddMarkdownCell")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={
            busy ||
            readOnly ||
            parsed.cells.every((cell) => cell.type !== "code")
          }
          className={iconButtonClass()}
          aria-label={t("notebookRunAll")}
          title={t("notebookRunAll")}
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => void interrupt()}
          disabled={!kernelStarted || !busy}
          className={iconButtonClass()}
          aria-label={t("notebookInterrupt")}
          title={t("notebookInterrupt")}
        >
          <CircleStop className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => void restart()}
          disabled={busy || readOnly}
          className={iconButtonClass()}
          aria-label={t("notebookRestart")}
          title={t("notebookRestart")}
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => void shutdown()}
          disabled={!kernelStarted || busy}
          className={iconButtonClass(true)}
          aria-label={t("notebookShutdown")}
          title={t("notebookShutdown")}
        >
          <Power className="size-4" />
        </button>
      </div>
      {(busy || error) && (
        <div
          className={`shrink-0 border-b px-3 py-1 text-xs ${
            error
              ? "border-destructive/30 text-destructive"
              : "border-border text-muted-foreground"
          }`}
        >
          {error ?? `${t("notebookKernel")}: ${t("notebookRunning")}`}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {parsed.cells.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("notebookEmpty")}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">
            {parsed.cells.map((cell, index) => (
              <Cell
                key={index}
                cell={cell}
                index={index}
                editingMarkdown={editingMarkdown === index}
                busy={busy || readOnly}
                readOnly={readOnly}
                t={t}
                onChange={(value) =>
                  updateContent((content) =>
                    setNotebookCellSource(content, index, value)
                  )
                }
                onEditMarkdown={() =>
                  setEditingMarkdown((current) =>
                    current === index ? null : index
                  )
                }
                onRun={() => void runCell(index, cell.source)}
                onDelete={() =>
                  updateContent((content) => deleteNotebookCell(content, index))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function errorMessageKey(error: NotebookParseError): NotebookMessage {
  if (error === "invalidJson") return "notebookInvalidJson"
  if (error === "invalidRoot") return "notebookInvalidRoot"
  return "notebookInvalidCells"
}

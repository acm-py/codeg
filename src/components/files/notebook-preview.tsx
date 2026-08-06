"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Streamdown } from "streamdown"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import {
  parseNotebook,
  type NotebookCell,
  type NotebookOutput,
  type NotebookParseError,
} from "@/lib/notebook"
import { useStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"

function CellMarkdown({ source }: { source: string }) {
  const plugins = useStreamdownPlugins(source)
  return <Streamdown plugins={plugins}>{source}</Streamdown>
}

function Output({ output }: { output: NotebookOutput }) {
  if (output.kind === "image" && output.dataUrl) {
    return <img src={output.dataUrl} alt="Notebook output" className="max-w-full rounded border border-border" />
  }
  return (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap rounded-md p-3 text-xs ${
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

type NotebookTranslator = (
  key: NotebookMessage,
  values?: { count?: number }
) => string

function Cell({
  cell,
  index,
  t,
}: {
  cell: NotebookCell
  index: number
  t: NotebookTranslator
}) {
  return (
    <article className="rounded-lg border border-border/70 bg-background/70 p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{t("notebookCell", { count: index + 1 })}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{cell.type}</span>
        {cell.type === "code" && <span className="font-mono">{cell.language}</span>}
        {cell.type === "code" && cell.executionCount !== null && (
          <span className="ml-auto font-mono">[{cell.executionCount}]</span>
        )}
      </div>
      {cell.type === "markdown" ? (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <CellMarkdown source={cell.source} />
        </div>
      ) : (
        <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs leading-5">
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
    </article>
  )
}

export function NotebookPreview({ tab }: { tab: FileWorkspaceTab }) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const parsed = useMemo(() => parseNotebook(tab.content ?? ""), [tab.content])
  const title = tab.title || tab.path.split(/[\\/]/).pop() || "Notebook"

  if ("error" in parsed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {t(errorMessageKey(parsed.error))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <span className="min-w-0 truncate text-sm font-medium" title={title}>{title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {[parsed.kernel, parsed.language, t("notebookCells", { count: parsed.cells.length })].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {parsed.cells.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("notebookEmpty")}</div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">
            {parsed.cells.map((cell, index) => <Cell key={index} cell={cell} index={index} t={t} />)}
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

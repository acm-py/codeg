import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import { NotebookPreview } from "./notebook-preview"

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ updateFileTabContent: vi.fn() }),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock("@/lib/api", () => ({
  notebookKernelListSpecs: vi.fn().mockResolvedValue([]),
}))

const messages = {
  Folder: {
    fileWorkspacePanel: {
      notebookCell: "Cell {count}",
      notebookCells: "{count} cells",
      notebookEmptyCell: "Empty cell",
      notebookEmpty: "Empty notebook",
      notebookInvalidJson: "Invalid JSON",
      notebookInvalidRoot: "Invalid root",
      notebookInvalidCells: "Invalid cells",
      notebookAddCodeCell: "Add code cell",
      notebookAddMarkdownCell: "Add Markdown cell",
      notebookDeleteCell: "Delete cell {count}",
      notebookRunCell: "Run cell {count}",
      notebookRunAll: "Run all",
      notebookInterrupt: "Interrupt",
      notebookRestart: "Restart",
      notebookShutdown: "Shutdown",
      notebookKernel: "Kernel",
      notebookSelectKernel: "Select kernel",
      notebookRunning: "Running",
      notebookKernelUnavailable: "Kernel unavailable",
      notebookInputPrompt: "Input",
      notebookHtmlOutput: "Notebook HTML output",
    },
  },
}

describe("NotebookPreview", () => {
  it("renders HTML output in a strict sandboxed iframe", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <NotebookPreview
          tab={{
            id: "notebook-tab",
            kind: "file",
            folderId: null,
            title: "example.ipynb",
            description: null,
            path: "/work/example.ipynb",
            language: "json",
            content: JSON.stringify({
              cells: [
                {
                  cell_type: "code",
                  source: "df",
                  outputs: [
                    {
                      output_type: "display_data",
                      data: {
                        "text/html": "<table><tr><td>PBCASH</td></tr></table>",
                      },
                    },
                  ],
                },
              ],
            }),
            loading: false,
          }}
        />
      </NextIntlClientProvider>
    )

    const frame = screen.getByTitle("Notebook HTML output")
    expect(frame).toHaveAttribute("sandbox", "")
    expect(frame).toHaveAttribute("srcDoc", expect.stringContaining("<table>"))
  })
})

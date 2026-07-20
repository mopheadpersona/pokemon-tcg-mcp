/** Shared MCP tool plumbing: text results and the error guard. */

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Tool failed: ${message}`, true);
  }
}

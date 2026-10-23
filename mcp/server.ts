import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { CommandError } from '../src/app/core/store/command';
import { ToolError, type ToolDef } from './tool';
import { componentTools } from './tools/components';
import { deckTools } from './tools/deck';
import { elementTools } from './tools/elements';
import { schemaTools } from './tools/schema';
import { slideTools } from './tools/slides';
import { Workspace, type WorkspaceOptions } from './workspace';

export const TOOLS: readonly ToolDef[] = [...schemaTools, ...deckTools, ...slideTools, ...elementTools, ...componentTools];

/** Runs one tool. A refusal is a tool error the agent can read and act on; anything unexpected is reported without a stack trace. */
export async function callTool(workspace: Workspace, tool: ToolDef, input: unknown): Promise<CallToolResult> {
  try {
    const value = await tool.run(workspace, input as never);
    return { content: [{ type: 'text', text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
  } catch (e) {
    const message = e instanceof ToolError || e instanceof CommandError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

export function createServer(options: WorkspaceOptions): { server: McpServer; workspace: Workspace } {
  const workspace = new Workspace(options);
  const server = new McpServer(
    { name: 'decktech', version: '0.1.0' },
    {
      instructions:
        'Tools to build DeckTech slide decks. Start with describe_schema, then create_deck. Code components are untrusted: this server never runs them, and DeckTech asks for review when the exported deck is opened.',
    },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly === true, openWorldHint: false },
      },
      async (input) => callTool(workspace, tool, input),
    );
  }
  return { server, workspace };
}

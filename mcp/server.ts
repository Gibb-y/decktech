import guide from './guide.md';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { CommandError } from '../src/app/core/store/command';
import { ToolError, ToolImages, type ToolDef } from './tool';
import { componentTools } from './tools/components';
import { deckTools } from './tools/deck';
import { elementTools } from './tools/elements';
import { libraryTools } from './tools/libraries';
import { previewTools } from './tools/preview';
import { schemaTools } from './tools/schema';
import { slideTools } from './tools/slides';
import { tableVideoTools } from './tools/table-video';
import { Workspace, type WorkspaceOptions } from './workspace';

export const TOOLS: readonly ToolDef[] = [
  ...schemaTools,
  ...deckTools,
  ...slideTools,
  ...elementTools,
  ...tableVideoTools,
  ...libraryTools,
  ...componentTools,
  ...previewTools,
];

/** Runs one tool. A refusal is a tool error the agent can read and act on; anything unexpected is reported without a stack trace. */
export async function callTool(
  workspace: Workspace,
  tool: ToolDef,
  input: unknown,
): Promise<CallToolResult> {
  try {
    const value = await tool.run(workspace, input as never);
    const data = value instanceof ToolImages ? value.data : value;
    const images = value instanceof ToolImages ? value.images : [];
    return {
      content: [
        {
          type: 'text',
          text: typeof data === 'string' ? data : JSON.stringify(data ?? { ok: true }, null, 2),
        },
        ...images.map((png) => ({
          type: 'image' as const,
          data: Buffer.from(png).toString('base64'),
          mimeType: 'image/png',
        })),
      ],
    };
  } catch (e) {
    const message =
      e instanceof ToolError || e instanceof CommandError
        ? e.message
        : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

export function createServer(options: WorkspaceOptions): {
  server: McpServer;
  workspace: Workspace;
} {
  const workspace = new Workspace(options);
  const server = new McpServer(
    { name: 'decktech', version: '0.1.0' },
    {
      instructions:
        'Tools to build DeckTech slide decks (1920x1080 stage; element order is reading order; alt text is required for images). FIRST read the guide: call describe_schema with topic "guide" (also the resource decktech://guide). Then create_deck, add slides and content, check_accessibility, export_deck. Code components are untrusted: the server only runs them for previews, which the server owner must enable, and DeckTech asks the person to review the code when the exported deck is opened.',
    },
  );
  server.registerResource(
    'guide',
    'decktech://guide',
    {
      title: 'DeckTech MCP guide for agents',
      description:
        'Workflow, accessibility rules, how to write code components and how to read errors.',
      mimeType: 'text/markdown',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide }] }),
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

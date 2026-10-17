import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const port = Number(process.argv[2]);
const token = String(process.argv[3] || '');
const endpoint = `http://127.0.0.1:${port}/mcp`;

async function request(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `SpCode MCP bridge HTTP ${response.status}`);
  return data;
}

const server = new Server({ name: 'spcode', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await request('tools/list');
  return { tools: result.tools };
});
server.setRequestHandler(CallToolRequestSchema, async (call) => request('tools/call', {
  name: call.params.name,
  arguments: call.params.arguments || {},
  toolCallId: call.params._meta?.progressToken || ''
}));
await server.connect(new StdioServerTransport());

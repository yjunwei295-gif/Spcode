import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const port = Number(process.argv[2]);
const token = String(process.argv[3] || '');
const endpoint = `http://127.0.0.1:${port}/mcp`;

/**
 * 把本地 MCP 请求转交给当前轮绑定的 HTTP 桥，保留所有工具参数。
 * @param {string} method 工具清单或工具调用的请求方法。
 * @param {object} params MCP 请求参数。运行命令时单独标记，供接收端按命令正文处理。
 * @returns {Promise<object>} HTTP 桥返回的 JSON，HTTP 失败时抛出桥返回的错误。
 */
async function request(method, params = {}) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (method === 'tools/call' && params.name === 'run_command') headers['x-spcode-command'] = '1';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
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

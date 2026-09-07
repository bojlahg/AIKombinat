#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const endpoint = process.env.AIKOMBINAT_DELEGATION_ENDPOINT;
const executionId = process.env.AIKOMBINAT_EXECUTION_ID;
const capability = process.env.AIKOMBINAT_DELEGATION_CAPABILITY;
const depth = Number(process.env.AIKOMBINAT_DELEGATION_DEPTH || '0');

if (!endpoint || !executionId || !capability || depth > 0) process.exit(1);

const server = new McpServer({ name: 'kombinat-delegation', version: '1.0.0' });
server.registerTool('bulk_read', {
  description: 'Analyze one large workspace file with the configured Delegation Worker and return validated relevant line ranges plus server-extracted evidence. Use targeted reads on those ranges afterward.',
  inputSchema: {
    path: z.string(),
    query: z.string().min(1).max(4000),
    max_ranges: z.number().int().positive().max(100).optional(),
  },
}, async (args) => {
  try {
    const response = await fetch(`${endpoint}/internal/delegation/bulk-read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aikombinat-execution-id': executionId,
        'x-aikombinat-delegation-capability': capability,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: !response.ok };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error_code: 'transport_error', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());

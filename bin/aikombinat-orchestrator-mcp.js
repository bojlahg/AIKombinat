#!/usr/bin/env node
import { createInterface } from 'node:readline';

const endpoint = process.env.AIKOMBINAT_ORCHESTRATOR_ENDPOINT;
const capability = process.env.AIKOMBINAT_ORCHESTRATOR_CAPABILITY;
if (!endpoint || !capability) process.exit(1);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sequence = Promise.resolve();
lines.on('line', line => {
  sequence = sequence.then(async () => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    let result;
    try {
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kombinat-orchestrator', version: '1.0.0' } };
      else if (request.method === 'ping') result = {};
      else {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
          body: JSON.stringify({ method: request.method, params: request.params }), signal: AbortSignal.timeout(30_000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'orchestrator_transport_error');
        result = body;
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'orchestrator_error' } })}\n`);
    }
  }).catch(() => undefined);
});

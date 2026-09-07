#!/usr/bin/env node

const provider = process.argv[2];
const endpoint = process.env.AIKOMBINAT_DELEGATION_ENDPOINT;
const executionId = process.env.AIKOMBINAT_EXECUTION_ID;
const capability = process.env.AIKOMBINAT_DELEGATION_CAPABILITY;
const depth = Number(process.env.AIKOMBINAT_DELEGATION_DEPTH || '0');

if (!endpoint || !executionId || !capability || depth > 0 || !['claude', 'codex'].includes(provider)) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(input || '{}');
    const response = await fetch(`${endpoint}/internal/delegation/hook/${provider}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aikombinat-execution-id': executionId,
        'x-aikombinat-delegation-capability': capability,
        'x-aikombinat-delegation-depth': String(depth),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) process.exit(0);
    const result = await response.json();
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } catch {
    // Delegation is a cost optimization boundary. Hook infrastructure fails open.
  }
});

import type { CliTool } from '../services/cli-adapters.js';

export type DelegationWorkerIsolationStrategy = 'tools_disabled' | 'scratch_only_filesystem' | 'provider_sandbox' | 'unsupported';

export interface DelegationWorkerIsolationCapability {
  provider: Exclude<CliTool, 'raw-shell'>;
  proven: boolean;
  strategy: DelegationWorkerIsolationStrategy;
  evidence: string;
}

const CAPABILITIES: Record<Exclude<CliTool, 'raw-shell'>, DelegationWorkerIsolationCapability> = {
  claude: {
    provider: 'claude',
    proven: true,
    strategy: 'tools_disabled',
    evidence: 'Claude CLI --tools "" removes all built-in tools; a worker-only empty --strict-mcp-config removes ambient MCP tools.',
  },
  codex: {
    provider: 'codex',
    proven: false,
    strategy: 'unsupported',
    evidence: 'Codex --sandbox read-only governs command execution but does not prove a tool-less or scratch-only host-read boundary.',
  },
  antigravity: {
    provider: 'antigravity',
    proven: false,
    strategy: 'unsupported',
    evidence: 'Antigravity --sandbox documents terminal restrictions but no tool-less or scratch-only host-read boundary.',
  },
};

export function getDelegationWorkerIsolationCapability(tool: CliTool): DelegationWorkerIsolationCapability | null {
  return tool === 'raw-shell' ? null : CAPABILITIES[tool];
}

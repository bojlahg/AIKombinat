import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ComputeNode, NodeConnection, NodeInventory, NodeObservation } from './resource-fabric-types.js';

export interface ProbeResult { stdout: string; stderr: string; code: number | null; timed_out: boolean }
export type CommandRunner = (command: string, args: string[], timeout?: number) => Promise<ProbeResult>;
export function boundedDiagnostic(value: string): string {
  return value.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[redacted]')
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]').replace(/((?:token|password|passphrase|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[redacted]').slice(-512);
}
export const runProbe: CommandRunner = (command, args, timeout = 5000) => new Promise(resolve => {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, settled = false;
  const finish = (code: number | null, timed_out: boolean) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    resolve({ stdout, stderr: boundedDiagnostic(stderr), code, timed_out });
  };
  const timer = setTimeout(() => { child.kill(); finish(null, true); }, timeout);
  const consume = (chunk: Buffer, error: boolean) => {
    bytes += chunk.length;
    if (bytes > 128 * 1024) { child.kill(); stderr = 'Probe output limit exceeded'; finish(null, false); return; }
    if (error) stderr += chunk.toString(); else stdout += chunk.toString();
  };
  child.stdout.on('data', chunk => consume(chunk, false)); child.stderr.on('data', chunk => consume(chunk, true));
  child.on('error', error => { stderr = error.message; finish(null, false); });
  child.on('close', code => finish(code, false));
});

export const connectionSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().max(64).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/).optional(),
  auth_mode: z.enum(['config', 'agent', 'key']),
  key_path: z.string().min(1).max(1024).refine(value => !/[\r\n\0]/.test(value)).optional(),
  workspace_root: z.string().min(2).max(1024).regex(/^\/[a-zA-Z0-9_./ -]+$/).refine(value => !value.split('/').includes('..') && value !== '/'),
}).strict().refine(value => value.auth_mode !== 'key' || !!value.key_path, 'Explicit key path required');

export function sshArgs(connection: NodeConnection, command: string): string[] {
  connectionSchema.parse(connection);
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
  if (connection.port) args.push('-p', String(connection.port));
  if (connection.user) args.push('-l', connection.user);
  if (connection.auth_mode === 'key') args.push('-i', connection.key_path!);
  if (connection.auth_mode === 'agent') args.push('-o', 'IdentityFile=none');
  return [...args, '--', connection.host, command];
}
export function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export async function discoverSshHosts(configPath = path.join(os.homedir(), '.ssh', 'config')): Promise<string[]> {
  try {
    const data = await fs.readFile(configPath, 'utf8');
    if (data.length > 256 * 1024) throw new Error('SSH config is too large');
    return [...new Set(data.split(/\r?\n/).filter(line => /^\s*Host\s+/i.test(line)).flatMap(line => line.replace(/^\s*Host\s+/i, '').replace(/#.*/, '').trim().split(/\s+/)).filter(alias => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(alias)))].sort();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

const WINDOWS_INVENTORY = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Processor; $c=Get-CimInstance Win32_ComputerSystem; $o=Get-CimInstance Win32_OperatingSystem; $d=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'; @{hostname=$c.Name;version=$o.Version;model=($p.Name -join ', ');physical=($p | Measure-Object NumberOfCores -Sum).Sum;logical=($p | Measure-Object NumberOfLogicalProcessors -Sum).Sum;total=[double]$c.TotalPhysicalMemory;free=[double]$o.FreePhysicalMemory*1024;identity=(Get-CimInstance Win32_ComputerSystemProduct).UUID;storage=@($d | ForEach-Object {@{mount=$_.DeviceID;total_bytes=[double]$_.Size;free_bytes=[double]$_.FreeSpace;filesystem=$_.FileSystem}})} | ConvertTo-Json -Depth 4 -Compress`;
const GPU_ARGS = ['--query-gpu=index,uuid,name,memory.total,driver_version,utilization.gpu,memory.used,temperature.gpu,power.draw', '--format=csv,noheader,nounits'];
const GPU_PID_ARGS = ['--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits'];
function numeric(value: string): number | null { const number = Number(value); return value.trim() && Number.isFinite(number) && number >= 0 ? number : null; }

export function parseNvidia(output: string, processes: string): { gpus: NodeInventory['gpus']; telemetry: NodeObservation['gpus'] } {
  const gpus: NodeInventory['gpus'] = [], telemetry: NodeObservation['gpus'] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const cells = line.split(',').map(value => value.trim());
    if (cells.length !== 9 || !/^GPU-[\w-]+$/.test(cells[1]) || numeric(cells[0]) === null || numeric(cells[3]) === null) continue;
    gpus.push({ local_index: Number(cells[0]), hardware_uuid: cells[1], model: cells[2].slice(0, 128), vram_bytes: Number(cells[3]) * 1024 * 1024, driver_version: cells[4] });
    telemetry.push({ hardware_uuid: cells[1], utilization: numeric(cells[5]), memory_used_bytes: numeric(cells[6]) === null ? null : Number(cells[6]) * 1024 * 1024, temperature: numeric(cells[7]), power: numeric(cells[8]), compute_pids: processes.split(/\r?\n/).flatMap(row => { const [uuid, pid] = row.split(',').map(value => value.trim()); return uuid === cells[1] && /^\d+$/.test(pid) && Number(pid) > 0 ? [Number(pid)] : []; }).slice(0, 128) });
  }
  return { gpus, telemetry };
}

export async function scanNode(node: ComputeNode, runner: CommandRunner = runProbe): Promise<{ inventory: NodeInventory; observation: NodeObservation; identity: string }> {
  const probe = (command: string, args: string[] = []) => node.transport === 'ssh'
    ? runner('ssh', sshArgs(node.connection!, [command, ...args].map(shellQuote).join(' ')), 8000)
    : runner(command, args);
  let inventory: NodeInventory;
  let identity: string;
  if (node.transport === 'local' && process.platform === 'win32') {
    const result = await probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_INVENTORY]);
    if (result.code !== 0) throw new Error(result.stderr || 'Local platform probe failed');
    const data = JSON.parse(result.stdout);
    inventory = { platform: { os: 'windows', version: data.version, arch: os.arch() === 'x64' ? 'x86_64' : os.arch(), hostname: data.hostname }, cpu: { model: data.model, physical_cores: data.physical || null, logical_threads: data.logical, threads_per_core: data.physical ? data.logical / data.physical : null, flags: [] }, memory: { total_bytes: data.total, available_bytes: data.free }, storage: data.storage ?? [], gpus: [], capabilities: {} };
    identity = data.identity;
  } else {
    const uname = await probe('uname', ['-s']);
    if (uname.code !== 0) throw new Error(uname.stderr || 'Node platform probe failed');
    const names = await probe('uname', ['-mn']);
    const release = await probe('cat', ['/etc/os-release']);
    const cpu = await probe('lscpu', ['-J']);
    const memory = await probe('cat', ['/proc/meminfo']);
    const disks = await probe('df', ['-Pk']);
    const machine = await probe('cat', ['/etc/machine-id']);
    const fields: Record<string, string> = {};
    try { for (const entry of JSON.parse(cpu.stdout).lscpu ?? []) fields[entry.field.replace(/:$/, '')] = String(entry.data); } catch { /* optional topology */ }
    const mem = Object.fromEntries([...memory.stdout.matchAll(/^(\w+):\s+(\d+) kB/gm)].map(match => [match[1], Number(match[2]) * 1024]));
    const releaseField = (key: string) => release.stdout.match(new RegExp(`^${key}=["']?([^"'\\r\\n]+)`, 'm'))?.[1];
    const logical = Number(fields['CPU(s)']) || (node.transport === 'local' ? os.cpus().length : 0);
    const physical = Number(fields['Core(s) per socket']) * Number(fields['Socket(s)']) || null;
    const [hostname, arch] = names.stdout.trim().split(/\s+/);
    inventory = { platform: { os: uname.stdout.trim().toLowerCase(), distro: releaseField('ID'), version: releaseField('VERSION_ID'), arch: arch || os.arch(), hostname }, cpu: { model: fields['Model name'] || 'unknown', physical_cores: physical, logical_threads: logical, threads_per_core: physical ? logical / physical : null, flags: (fields.Flags ?? '').split(/\s+/).filter(flag => /^avx/.test(flag)) }, memory: { total_bytes: mem.MemTotal || (node.transport === 'local' ? os.totalmem() : 0), available_bytes: mem.MemAvailable ?? mem.MemFree ?? (node.transport === 'local' ? os.freemem() : 0) }, storage: disks.stdout.trim().split(/\r?\n/).slice(1).flatMap(line => { const row = line.trim().split(/\s+/); return row.length >= 6 && /^\d+$/.test(row[1]) ? [{ mount: row.slice(5).join(' '), total_bytes: Number(row[1]) * 1024, free_bytes: Number(row[3]) * 1024 }] : []; }), gpus: [], capabilities: {} };
    identity = machine.stdout.trim() || `${hostname}/${inventory.platform.os}`;
  }
  if (!inventory.cpu.logical_threads || !inventory.memory.total_bytes || !inventory.platform.hostname) throw new Error('Incomplete required node inventory');
  for (const flag of inventory.cpu.flags) inventory.capabilities[flag] = true;
  const gpu = await probe('nvidia-smi', GPU_ARGS), pids = await probe('nvidia-smi', GPU_PID_ARGS);
  const nvidia = parseNvidia(gpu.stdout, pids.stdout);
  inventory.gpus = nvidia.gpus;
  if (nvidia.gpus.length) {
    const compatibility = await probe('nvidia-smi');
    const cuda = compatibility.stdout.match(/CUDA Version:\s*([\d.]+)/)?.[1];
    if (cuda) { inventory.capabilities.cuda_compatibility = cuda; for (const gpu of inventory.gpus) gpu.cuda = cuda; }
  }
  for (const [capability, command, args] of [['git', 'git', ['--version']], ['docker', 'docker', ['--version']], ['python', node.transport === 'ssh' ? 'python3' : 'python', ['--version']], ['node', 'node', ['--version']], ['ffmpeg', 'ffmpeg', ['-version']], ['cuda', 'nvcc', ['--version']], ['nvidia_container_runtime', 'nvidia-container-runtime', ['--version']]] as const) {
    const result = await probe(command, [...args]);
    if (result.code === 0) inventory.capabilities[capability] = (result.stdout + result.stderr).match(capability === 'ffmpeg' ? /^ffmpeg version n?(\d+\.\d+(?:\.\d+)?)(?:\s|-|$)/im : /(?:release\s+|\bv)?(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? true;
  }
  if (node.transport === 'local') {
    if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) inventory.capabilities.android_sdk = true;
  }
  const unity = await probe(node.transport === 'local' && process.platform === 'win32' ? 'where.exe' : 'which', ['Unity']);
  if (unity.code === 0) inventory.capabilities.unity = true;
  const android = await probe('adb', ['version']);
  if (android.code === 0) inventory.capabilities.android_sdk = true;
  const observation: NodeObservation = { timestamp: new Date().toISOString(), memory_available_bytes: inventory.memory.available_bytes, storage: inventory.storage, gpus: nvidia.telemetry };
  return { inventory, observation, identity: createHash('sha256').update(`${inventory.platform.hostname}/${inventory.platform.os}/${identity}`).digest('hex') };
}

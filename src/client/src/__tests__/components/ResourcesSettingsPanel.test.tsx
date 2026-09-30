import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../../i18n';
import ResourcesSettingsPanel from '../../components/settings/ResourcesSettingsPanel';
import ResourceRequirementPicker from '../../components/ResourceRequirementPicker';
import * as api from '../../api/resources';
import type { FabricView } from '../../api/resources';
import type { ResourceRequirements } from '../../types';
import { useState } from 'react';

vi.mock('../../api/resources', () => ({ getFabric: vi.fn(), getResourceRequests: vi.fn(), getResourceLeases: vi.fn(), discoverHosts: vi.fn(), createSshNode: vi.fn(), updateNode: vi.fn(), deleteNode: vi.fn(), scanNode: vi.fn(), testNode: vi.fn(), updateNodePolicy: vi.fn(), updateGpuPolicy: vi.fn(), stopResourceTodo: vi.fn(), getScanHistory: vi.fn(), getResources: vi.fn() }));
vi.mock('../../api/todos', () => ({ getTodoLogs: vi.fn().mockResolvedValue([]) }));
let data: FabricView;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  data = { nodes: [{ id: 'local-id', name: 'Workstation', transport: 'local', enabled: true, scheduler_state: 'online', identity: 'fixture', identity_changed: false, last_scan_at: null, last_health_at: null, last_error: null, connection: null, inventory: { platform: { os: 'windows', arch: 'x86_64', hostname: 'fixture' }, cpu: { model: 'Fixture CPU', physical_cores: 16, logical_threads: 32, threads_per_core: 2, flags: [] }, memory: { total_bytes: 64 * 1024 ** 3, available_bytes: 32 * 1024 ** 3 }, storage: [], gpus: [], capabilities: {} }, observation: null, policy: { cpu_reserve_threads: 8, memory_reserve_bytes: 16 * 1024 ** 3, storage_reserve_bytes: 0, memory_safety_bytes: 1024 ** 3, avoid_external_gpu: true, capability_overrides: {} } }], instances: [{ id: 'gpu-id', node_id: 'local-id', kind: 'gpu', legacy_key: null, hardware_uuid: 'GPU-fixture', local_index: 0, model: 'RTX 3070', vram_bytes: 8 * 1024 ** 3, origin: 'detected', present: 1, policy: 'enabled', desired_policy: null, reserve_reason: null, used: 0, externally_busy: true, runtime_state: 'externally_busy' }], capacity: [{ node_id: 'local-id', cpu: { total: 32, reserve: 8, leased: 0, available: 24 }, memory: { total: 64 * 1024 ** 3, reserve: 16 * 1024 ** 3, leased: 0, available: 48 * 1024 ** 3 } }] };
  vi.mocked(api.getFabric).mockImplementation(async () => data);
  vi.mocked(api.getResourceRequests).mockResolvedValue({ requests: [{ id: 'request', owner_id: 'task', owner_type: 'todo', status: 'waiting', reasons_json: '[{"node_id":"local-id","reasons":["os_mismatch"]}]', requirements_json: '{}', created_at: '2026-09-30' }] });
  vi.mocked(api.getResourceLeases).mockResolvedValue({ leases: [] });
  vi.mocked(api.discoverHosts).mockResolvedValue({ hosts: ['fixture-host'] });
  vi.mocked(api.scanNode).mockResolvedValue({ node: data.nodes[0], diff: [] });
  vi.mocked(api.testNode).mockResolvedValue({ status: 'connected' });
  vi.mocked(api.getResources).mockResolvedValue({ resources: [], nodes: [{ id: 'local-id', name: 'Workstation' }] });
});
function panel() { return render(<MemoryRouter><I18nProvider><ResourcesSettingsPanel /></I18nProvider></MemoryRouter>); }
async function ready() { await screen.findByRole('heading', { name: 'Workstation' }); }
describe('Resource Fabric settings', () => {
  it('shows actual binary VRAM without rounding a 16 GB-class GPU up to 16 GiB', async () => {
    data.instances[0].vram_bytes = 16311 * 1024 ** 2;
    panel(); await ready(); expect(screen.getByText(/Detected VRAM: 15.93 GiB/)).toBeInTheDocument();
  });
  it('labels remote OpenCode as unsupported in Resource Fabric V2', async () => {
    data.nodes[0].transport = 'ssh';
    panel(); await ready(); expect(screen.getByText(/Remote OpenCode is not supported in Resource Fabric V2/)).toBeInTheDocument();
  });
  it('shows local topology, external usage and waiting reasons', async () => {
    panel(); await ready();
    expect(screen.getByText('16 physical cores / 32 logical threads')).toBeInTheDocument();
    expect(screen.getByText('External workload detected')).toBeInTheDocument();
    expect(screen.getByText(/os_mismatch/)).toBeInTheDocument();
  });
  it('scans the local node and saves quantitative reserves', async () => {
    panel(); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Scan this computer' }));
    await waitFor(() => expect(api.scanNode).toHaveBeenCalledWith('local-id'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save reserves' })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Reserve CPU threads'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reserves' }));
    await waitFor(() => expect(api.updateNodePolicy).toHaveBeenCalledWith('local-id', expect.objectContaining({ cpu_reserve_threads: 10, memory_reserve_bytes: 16 * 1024 ** 3 })));
  });
  it.each([['Reserve now', 'reserved', false], ['Reserve after current job', 'reserved', true], ['Release reservation', 'enabled', false], ['Disable', 'disabled', false]])('%s sends a persisted GPU policy action', async (label, policy, after) => {
    panel(); await ready(); fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => after ? expect(api.updateGpuPolicy).toHaveBeenCalledWith('gpu-id', policy, true) : expect(api.updateGpuPolicy).toHaveBeenCalledWith('gpu-id', policy));
  });
  it.each([['Drain', 'draining'], ['Enter maintenance', 'maintenance'], ['Return online', 'online']])('%s updates scheduler state', async (label, state) => {
    panel(); await ready(); fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(api.updateNode).toHaveBeenCalledWith('local-id', { scheduler_state: state }));
  });
  it('persists manual capability overrides separately from detected inventory', async () => {
    panel(); await ready(); fireEvent.change(screen.getByLabelText('Capability key'), { target: { value: 'docker' } });
    fireEvent.change(screen.getByLabelText('Version or true/false'), { target: { value: '27.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add override' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reserves' }));
    await waitFor(() => expect(api.updateNodePolicy).toHaveBeenCalledWith('local-id', expect.objectContaining({ capability_overrides: { docker: '27.0.0' } })));
  });
  it('imports an SSH alias into an editor without requesting secret material', async () => {
    panel(); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Discover SSH hosts' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Import alias'), { target: { value: 'fixture-host' } });
    fireEvent.change(within(dialog).getByLabelText('Remote workspace root'), { target: { value: '/jobs/fixture' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createSshNode).toHaveBeenCalledWith('fixture-host', { host: 'fixture-host', auth_mode: 'config', workspace_root: '/jobs/fixture' }, true));
    expect(within(dialog).queryByLabelText(/passphrase/i)).toBeNull();
  });
  it('shows offline nodes and lease owner links for quantitative resources', async () => {
    data.nodes[0].scheduler_state = 'offline';
    vi.mocked(api.getResourceLeases).mockResolvedValue({ leases: [{ id: 'lease', node_id: 'local-id', resource_key: 'node/local-id/cpu', amount: 8, owner_type: 'todo', owner_id: 'todo-id', owner_title: 'Real owner', project_id: 'project-id', process_pid: 123, execution_profile_id: null, execution_snapshot: '{"agent":"opencode","model":"provider/model"}', acquired_at: '2026-09-30', run_token: 'token', binding_id: 'binding' }] });
    panel(); await ready(); expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Real owner' })).toHaveAttribute('href', '/projects/project-id?todo=todo-id');
    expect(screen.getByText(/opencode.*provider\/model.*PID 123/)).toBeInTheDocument();
  });
  it('edits V2 GPU and RAM requirements without JSON and keeps existing values', async () => {
    const changes = vi.fn();
    function Form() { const [value, setValue] = useState<ResourceRequirements>({ version: 2, requires: { memory: { bytes: 16 * 1024 ** 3 } }, prefers: {} }); return <ResourceRequirementPicker value={value} onChange={next => { changes(next); setValue(next); }} />; }
    render(<I18nProvider><Form /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('GPU count'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('GPU model'), { target: { value: 'RTX 3070' } });
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ version: 2, requires: { memory: { bytes: 16 * 1024 ** 3 }, resources: [{ kind: 'gpu', count: 2, same_node: true, model: 'RTX 3070' }] } }));
  });
});

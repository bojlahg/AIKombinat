import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(profile|candidate|new-model|new-effort|source-db|report)=(.+)$/.exec(arg);
  if (!match) throw new Error(`Unknown smoke option: ${arg}`);
  return [match[1], match[2]];
}));
const sourcePath = path.resolve(args['source-db'] ?? process.env.DB_PATH ?? (fs.existsSync('aikombinat.db') ? 'aikombinat.db' : 'clitrigger.db'));
if (args.report) {
  const reportTarget = path.resolve(args.report);
  const canonical = (file: string) => (fs.existsSync(file) ? fs.realpathSync(file) : file).toLowerCase();
  assert.ok(!['', '-wal', '-shm'].some(suffix => canonical(sourcePath + suffix) === canonical(reportTarget)), 'Report cannot overwrite source database files');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-reconciliation-'));
process.env.DB_PATH = path.join(root, 'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(root, 'logs');
process.env.AIKOMBINAT_LOG_LEVEL = 'warn';
const report: Record<string, unknown> = { status: 'FAIL', startedAt: new Date().toISOString(), sourceReadOnly: true, inferenceLaunched: false };
function fingerprint() {
  return ['','-wal','-shm'].map(suffix => {
    const file = sourcePath + suffix;
    return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  });
}
const before = fingerprint();
const connection = await import('../src/server/db/connection.js');
try {
  if (!fs.existsSync(sourcePath)) throw new Error('source_database_missing');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const db = connection.getDatabase();
  try {
    db.transaction(() => {
      for (const table of ['execution_profile_executors','execution_profiles','cli_models','cli_versions','provider_account_quota_state','provider_accounts']) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of ['cli_models','cli_versions','provider_accounts','provider_account_quota_state','execution_profiles','execution_profile_executors','review_policies','review_policy_members']) {
        if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);
        const values = source.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[];
        for (const row of values) {
          if (table === 'provider_accounts' && (row.auth_strategy !== 'inherited' || row.auth_config_json !== '{}')) continue;
          if (['provider_account_quota_state','execution_profile_executors'].includes(table) && row.provider_account_id && !db.prepare('SELECT 1 FROM provider_accounts WHERE id=?').get(row.provider_account_id)) continue;
          const keys = columns.filter(key => key in row);
          db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
        }
      }
    })();
  } finally { source.close(); }
  const { migrateProviderAccounts } = await import('../src/server/db/provider-accounts.js'); migrateProviderAccounts(db);
  const q = await import('../src/server/db/queries.js');
  const { getToolStatus } = await import('../src/server/services/cli-status.js');
  const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
  const s = await import('../src/server/services/execution-profile-reconciliation.js');
  const profileRows = JSON.stringify(db.prepare('SELECT * FROM execution_profiles ORDER BY id').all());
  const candidateRows = JSON.stringify(db.prepare('SELECT * FROM execution_profile_executors ORDER BY id').all());
  for (const tool of ['claude','codex','opencode','antigravity'] as const) {
    const status = await getToolStatus(tool);
    if (status?.installed && status.usable !== false) await refreshModelCatalog(tool, { explicitRefresh: true, version: status.version ?? '' });
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM execution_profiles ORDER BY id').all()), profileRows);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM execution_profile_executors ORDER BY id').all()), candidateRows);
  const reconciliation = await s.reconcileExecutionProfiles();
  report.reconciliation = reconciliation;
  report.refreshMutatedProfiles = false;
  if (args['new-model']) {
    assert.ok(args.profile && args.candidate, 'Explicit repair requires --profile and --candidate');
    const profile = q.getExecutionProfileById(args.profile); assert.ok(profile);
    const candidate = profile.executors.find(item => item.id === args.candidate); assert.ok(candidate);
    const newModel = q.getModelByValue(candidate.cli_tool, args['new-model']); assert.ok(newModel);
    const oldHealth = reconciliation.profiles.find(item => item.id === profile.id)!.health;
    s.rebindExecutionCandidate(profile.id, candidate.id, { newModelId: newModel.id, expectedOldModelId: candidate.cli_model_id,
      expectedProfileUpdatedAt: profile.updated_at, ...(args['new-effort'] ? { newEffort: args['new-effort'] } : {}) });
    const newHealth = (await s.reconcileExecutionProfiles()).profiles.find(item => item.id === profile.id)!.health;
    report.disposableRebind = { synthetic: false, oldModel: candidate.model_value, newModel: newModel.model_value, oldEffort: candidate.effort_value,
      newEffort: q.getExecutionProfileById(profile.id)!.executors.find(item => item.id === candidate.id)!.effort_value, beforeHealth: oldHealth, afterHealth: newHealth };
  } else {
    // Synthetic configuration proves repair without choosing a real model or launching inference.
    const old = q.addModel('codex', 'reconciliation-synthetic-old', 'Synthetic old', ['high']);
    const profile = q.createExecutionProfile({ slug: 'reconciliation-synthetic', name: 'Synthetic repair', description: '', executors: [{ cli_model_id: old.id, effort_value: 'high', priority: 0 }] });
    await refreshModelCatalog('codex', { discover: async () => ({ source: 'codex-app-server', authoritative: true, primarySucceeded: true,
      models: [{ value: 'reconciliation-synthetic-current', label: 'Synthetic current', supportedEfforts: ['high'] }] }) });
    const oldHealth = (await s.reconcileExecutionProfiles()).profiles.find(item => item.id === profile.id)!.health;
    const model = q.getModelByValue('codex','reconciliation-synthetic-current')!;
    s.rebindExecutionCandidate(profile.id, profile.executors[0].id, { newModelId: model.id, expectedOldModelId: old.id, expectedProfileUpdatedAt: profile.updated_at });
    const newHealth = (await s.reconcileExecutionProfiles()).profiles.find(item => item.id === profile.id)!.health;
    assert.equal(oldHealth, 'blocked'); assert.equal(newHealth, 'ready');
    report.disposableRebind = { synthetic: true, oldModel: old.model_value, newModel: model.model_value, oldEffort: 'high', newEffort: 'high', beforeHealth: oldHealth, afterHealth: newHealth };
  }
  report.auditRows = (db.prepare('SELECT COUNT(*) count FROM execution_profile_rebind_audit').get() as { count: number }).count;
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  report.foreignKeys = 'PASS'; report.status = 'PASS';
} catch (error) {
  const reason = error instanceof Error ? error.message : 'smoke_failed';
  report.reason = reason === 'source_database_missing' ? reason : 'smoke_failed';
  if (reason === 'source_database_missing') report.status = 'SKIPPED_ENVIRONMENT';
  else process.exitCode = 1;
} finally {
  connection.closeDatabase();
  report.sourceDatabaseUnchanged = JSON.stringify(before) === JSON.stringify(fingerprint());
  if (!report.sourceDatabaseUnchanged) { report.status = 'FAIL'; report.reason = 'source_database_changed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  const reportPath = args.report ? path.resolve(args.report) : path.join(root, 'report.json');
  assert.notEqual(reportPath, sourcePath);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`Result: ${report.status}\nSource DB unchanged: ${report.sourceDatabaseUnchanged}\nReport: ${reportPath}\n`);
}

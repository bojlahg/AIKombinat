import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'aikombinat-campaign-smoke-'));
const projectPath=path.join(root,'project');fs.mkdirSync(projectPath);
process.env.DB_PATH=path.join(root,'campaign.db');process.env.AIKOMBINAT_LOG_DIR=path.join(root,'logs');process.env.AIKOMBINAT_LOG_LEVEL='warn';
const { getDatabase,closeDatabase }=await import('../src/server/db/connection.js');
const q=await import('../src/server/db/queries.js');
const { saveReviewPolicy }=await import('../src/server/services/review-policy.js');
const { observeImplementationStart,observeReviewStart }=await import('../src/server/services/evaluation-campaign-service.js');
const db=getDatabase(),model=q.addModel('claude','smoke-reviewer','Smoke fixture reviewer',['low']);
const profile=q.createExecutionProfile({ name: 'Smoke reviewer',slug: 'campaign-smoke-reviewer',description: '',executors: [{ cli_model_id: model.id,effort_value: 'low',priority: 0 }] });
const policy=saveReviewPolicy({ name: 'Smoke consensus',members: [0,1].map(priority=>({ label: `Reviewer ${priority}`,execution_profile_id: profile.id,priority })) });
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as { port: number }).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
const base=`http://127.0.0.1:${port}`;
let controller: ChildProcess | undefined;
let tail='';
async function request(url: string,method='GET',body?: unknown,expected=200) {
  const response=await fetch(base+'/api'+url,{ method,headers: { 'Content-Type': 'application/json' },body: body===undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status,expected,`${method} ${url}: ${await response.clone().text()}`);
  return response.status===204 ? null : response.json();
}
async function start() {
  controller=spawn(process.execPath,['--import','tsx','src/server/index.ts'],{ cwd: path.resolve('.'),windowsHide: true,
    env: { ...process.env,PORT: String(port),BIND_HOST: '127.0.0.1',HEADLESS: 'false',DISABLE_AUTH: 'true',TUNNEL_ENABLED: 'false' },stdio: ['ignore','pipe','pipe'] });
  for (const stream of [controller.stdout,controller.stderr]) stream?.on('data',data=>{ tail=(tail+data.toString()).slice(-8192); });
  for (let i=0;i<150;i++) {
    if (controller.exitCode!==null) throw new Error(`Controller exited ${controller.exitCode}: ${tail}`);
    try { if ((await fetch(base+'/api/projects')).ok) return; } catch { /* booting */ }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error(`Controller startup timed out: ${tail}`);
}
async function stop() {
  if (!controller || controller.exitCode!==null) return;
  const child=controller,exit=once(child,'exit');child.kill();await exit;
  child.stdout?.destroy();child.stderr?.destroy();controller=undefined;
}
try {
  await start();
  const project=await request('/projects','POST',{ name: 'Evaluation Campaign Smoke',path: projectPath },201);
  const campaign=await request(`/projects/${project.id}/evaluation-campaigns`,'POST',{ name: 'Review Strategy Baseline Smoke',auto_enroll: 0,arms: [
    { name: 'Single',is_control: 1,weight: 1,sort_order: 0,review_mode: 'single',review_profile_id: profile.id },
    { name: 'Consensus',is_control: 0,weight: 1,sort_order: 1,review_mode: 'consensus',review_policy_id: policy.id },
  ] },201);
  await request(`/evaluation-campaigns/${campaign.id}/start`,'POST',{ projectId: project.id });
  const implementation={ title: 'Enrollment smoke',description: 'Disposable fixture; no provider execution',cli_tool: 'claude',cli_model: model.model_value,cli_effort: 'low',resource_requirements: [],use_worktree: 0,priority: 3 };
  const todo=await request(`/projects/${project.id}/todos`,'POST',{ ...implementation,evaluation_campaign_id: campaign.id,evaluation_campaign_enroll: true },201);
  assert.equal(todo.cli_tool,implementation.cli_tool);assert.equal(todo.cli_model,implementation.cli_model);assert.equal(todo.cli_effort,'low');assert.equal(todo.description,implementation.description);assert.equal(todo.resource_requirements,null);assert.equal(todo.priority,3);assert.equal(todo.review_enabled,1);
  const url=`/todos/${todo.id}/evaluation-assignment?projectId=${project.id}`;
  const original=await request(url);assert.ok(original.arm_id);assert.equal(original.integrity_state,'clean');
  await stop();await start();
  const restored=await request(url);assert.equal(restored.arm_id,original.arm_id);assert.equal(restored.assignment_bucket,original.assignment_bucket);assert.equal(restored.assignment_hash,original.assignment_hash);assert.equal(restored.assigned_review_config_hash,original.assigned_review_config_hash);assert.equal(restored.campaign_definition_hash,original.campaign_definition_hash);
  await request(`/todos/${todo.id}`,'PUT',{ review_enabled: 0 },409);await request(`/todos/${todo.id}`,'PUT',{ review_enabled: 0,evaluation_override: true });
  const contaminated=await request(`/evaluation-campaigns/${campaign.id}/analytics?projectId=${project.id}`);
  assert.equal(contaminated.arms.reduce((n: number,a: any)=>n+a.itt.assignments,0),1);assert.equal(contaminated.arms.reduce((n: number,a: any)=>n+a.pp.assignments,0),0);
  const feedbackTodo=await request(`/projects/${project.id}/todos`,'POST',{ title: 'Reached review fixture',description: 'No real AI execution',evaluation_campaign_id: campaign.id,evaluation_campaign_enroll: true },201);
  await request(`/todos/${feedbackTodo.id}/evaluation-assignment/feedback`,'PUT',{ projectId: project.id,label: 'helpful' },409);
  observeImplementationStart(feedbackTodo.id);observeReviewStart(feedbackTodo.id);
  q.createExecutionRound(feedbackTodo.id,'review',1,randomUUID(),{ status: 'completed',startedAt: new Date().toISOString(),resultPayload: JSON.stringify({ verdict: 'approved',summary: 'Synthetic fixture',issues: [] }),executionSnapshot: JSON.stringify({ agent: 'claude',effectiveModel: 'smoke-reviewer',effort: 'low',providerAccountId: 'fixture-account' }) });
  q.updateTodoStatus(feedbackTodo.id,'completed');
  await request(`/todos/${feedbackTodo.id}/evaluation-assignment/feedback`,'PUT',{ projectId: project.id,label: 'helpful',note: 'Smoke fixture feedback' });
  await request(`/todos/${feedbackTodo.id}/evaluation-assignment/feedback`,'PUT',{ projectId: project.id,label: 'not_helpful',note: 'Updated smoke fixture feedback' });
  const withdrawalTodo=await request(`/projects/${project.id}/todos`,'POST',{ title: 'Withdrawal UI fixture',evaluation_campaign_id: campaign.id,evaluation_campaign_enroll: true },201);
  const data=await request(`/evaluation-campaigns/${campaign.id}/analytics?projectId=${project.id}`);
  assert.equal(data.arms.reduce((n: number,a: any)=>n+a.itt.feedback.responses,0),1);
  assert.equal(data.arms.reduce((n: number,a: any)=>n+a.itt.feedback.notHelpful,0),1);
  assert.equal(data.arms.reduce((n: number,a: any)=>n+a.itt.reachedReview,0),1);
  const source=process.argv.find(arg=>arg.startsWith('--migration-source='))?.split('=').slice(1).join('=');
  let migration: unknown={ synthetic: true,foreignKeys: db.pragma('foreign_key_check') };
  if (source) {
    const originalDb=new Database(path.resolve(source),{ readonly: true,fileMustExist: true });
    const copyPath=path.join(root,'migration-copy.db');try { await originalDb.backup(copyPath); } finally { originalDb.close(); }
    const copy=new Database(copyPath);
    const { initDatabase }=await import('../src/server/db/schema.js');
    const tables=['todos','consensus_review_batches','consensus_review_jobs','review_evaluation_feedback','provider_accounts','provider_account_quota_state','orchestrators','orchestrator_turns'];
    const counts=()=>Object.fromEntries(tables.map(table=>[table,copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) ? (copy.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n : 0]));
    const before=counts();initDatabase(copy);initDatabase(copy);assert.deepEqual(counts(),before);assert.deepEqual(copy.pragma('foreign_key_check'),[]);migration={ synthetic: false,counts: before,twice: true,foreignKeys: [] };copy.close();
  }
  const report={ root,url: `${base}/projects/${project.id}`,projectId: project.id,campaignId: campaign.id,todoId: todo.id,feedbackTodoId: feedbackTodo.id,withdrawalTodoId: withdrawalTodo.id,
    campaign: await request(`/evaluation-campaigns/${campaign.id}?projectId=${project.id}`),assignment: await request(url),analytics: data,
    enrollment: 'passed',restart: 'passed',contamination: 'passed',feedback: 'passed',atomicCreate: 'covered by injected-crash regression',implementationUnchanged: true,
    migration,realReview: 'Not attempted: no verified safe/free provider path. Timestamps and outcome here use an explicit synthetic reached-review fixture.' };
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if (process.argv.includes('--serve')) { process.stdout.write('Disposable smoke controller ready for UI verification. Interrupt to stop.\n');await new Promise<void>(resolve=>{ process.once('SIGINT',resolve);process.once('SIGTERM',resolve); }); }
} finally { await stop();closeDatabase(); }

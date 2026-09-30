import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'aikombinat-consensus-real-'));
process.env.DB_PATH = path.join(root,'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(root,'logs');
const { getDatabase,closeDatabase } = await import('../src/server/db/connection.js');
const q = await import('../src/server/db/queries.js');
const { reviewPipeline } = await import('../src/server/services/review-pipeline.js');
const { saveReviewPolicy } = await import('../src/server/services/review-policy.js');
const { consensusReview,consensusHistory,getConsensusBatch } = await import('../src/server/services/consensus-review.js');
const { executorPool } = await import('../src/server/services/executor-pool.js');
const { getToolStatus } = await import('../src/server/services/cli-status.js');
const { providerQuotaService } = await import('../src/server/services/provider-quota.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const workDir = path.join(root,'project');fs.mkdirSync(workDir);
const git = (...args: string[]) => execFileSync('git',args,{ cwd: workDir,encoding: 'utf8',windowsHide: true });
const report: Record<string,unknown> = { os: `${os.platform()} ${os.release()}`,root };
let failure: unknown;
try {
  git('init');git('config','user.name','Consensus Smoke');git('config','user.email','consensus-smoke@example.invalid');
  fs.writeFileSync(path.join(workDir,'sum.js'),'export const sum = (a, b) => a - b;\n');git('add','.');git('commit','-m','Tiny fixture baseline');
  const project = q.createProject('Disposable consensus smoke',workDir);
  const todo = q.createTodo(project.id,'Fix sum','Change sum(a,b) to return a+b. Review only the supplied one-line change.');
  q.updateTodo(todo.id,{ review_enabled: 1,review_mode: 'consensus',max_review_rounds: 1,max_turns: 3 });
  await reviewPipeline.captureBaseline(todo.id,workDir,true);
  fs.writeFileSync(path.join(workDir,'sum.js'),'export const sum = (a, b) => a + b;\n');
  const artifact = await reviewPipeline.collectReviewArtifact(q.getTodoById(todo.id)!,project);
  if (!artifact.identity) throw new Error('Smoke artifact unavailable');
  const providers = process.argv.includes('--heterogeneous') ? ['claude','claude','codex'] as const : ['claude','claude'] as const;
  const profiles = providers.map((provider,i) => {
  const codexModel = provider === 'codex' ? fs.readFileSync(path.join(os.homedir(),'.codex','config.toml'),'utf8').match(/^model\s*=\s*"([^"]+)"/m)?.[1] : null;
  if (provider === 'codex' && !codexModel) throw new Error('No configured Codex model for heterogeneous smoke');
  const modelValue = provider === 'claude' ? 'haiku' : codexModel!;
  const model = q.getModelByValue(provider,modelValue) ?? q.addModel(provider,modelValue,provider);
  const profile = q.createExecutionProfile({ slug: `real-reviewer-${i}`,name: `Real ${provider} reviewer ${i+1}`,description: 'Read-only tiny smoke',
    executors: [{ cli_model_id: model.id,effort_value: null,priority: 0,is_enabled: 1,account_policy: 'inherited_default',provider_account_id: null }] });
  return profile;
  });
  const policy = saveReviewPolicy({ name: 'Real majority smoke',strategy: 'majority',failure_policy: 'require_all',max_parallel_reviewers: providers.length,
    members: profiles.map((profile,i) => ({ execution_profile_id: profile.id,label: `Reviewer ${i + 1}`,weight: 1,priority: i })) });
  q.updateTodo(todo.id,{ review_policy_id: policy.id });
  const prompt = reviewPipeline.buildReviewPrompt({ todo: q.getTodoById(todo.id)!,project,roundIndex: 2,attemptNumber: 1,maxAttempts: 1,diffSummary: artifact.summary });
  const round = q.createExecutionRound(todo.id,'review',2,'smoke-review',{ inputPayload: prompt,artifactIdentity: JSON.stringify(artifact.identity) });
  executorPool.setAvailabilityCallback(() => consensusReview.wake());resourceManager.setAvailabilityCallback(() => consensusReview.wake());
  providerQuotaService.setAvailabilityCallback(() => consensusReview.wake());providerQuotaService.initialize();
  report.cli = await Promise.all([...new Set(providers)].map(provider => getToolStatus(provider)));report.policy = policy;report.artifact = artifact.identity;
  const batch = consensusReview.start(todo.id,round.id), seenPids = new Set<number>();
  const deadline = Date.now()+180000;
  while (Date.now()<deadline) {
    for (const job of consensusHistory(todo.id)[0].jobs) for (const attempt of job.attempts) if (attempt.process_pid > 0) seenPids.add(attempt.process_pid);
    const current = getConsensusBatch(batch.id)!;
    if (['completed','failed','stopped','recovery_required'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve,500));
  }
  report.history = consensusHistory(todo.id);report.seenPids = [...seenPids];report.todoStatus = q.getTodoById(todo.id)?.status;
  report.mutationCheck = JSON.stringify((await reviewPipeline.collectReviewArtifact(q.getTodoById(todo.id)!,project)).identity) === JSON.stringify(artifact.identity);
  if (getConsensusBatch(batch.id)?.status !== 'completed' || seenPids.size < 2 || report.mutationCheck !== true) throw new Error('Real smoke did not satisfy acceptance');
  report.result = 'PASS';
} catch (error) { failure = error;report.result = 'FAIL';report.error = error instanceof Error ? error.message : String(error); }
finally {
  await consensusReview.shutdown();resourceManager.shutdown();providerQuotaService.shutdown();
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));closeDatabase();
  process.stdout.write(JSON.stringify({ result: report.result,error: report.error,reportPath: path.join(root,'report.json') })+'\n');
}
if (failure) process.exitCode = 1;

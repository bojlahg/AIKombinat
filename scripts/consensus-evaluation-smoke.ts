import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourcePath=process.argv[2];
if (!sourcePath) throw new Error('Usage: npx tsx scripts/consensus-evaluation-smoke.ts <existing SQLite history>');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'aikombinat-evaluation-'));
const source=new Database(path.resolve(sourcePath),{ readonly: true,fileMustExist: true });
try { await source.backup(path.join(root,'evaluation.db')); } finally { source.close(); }
process.env.DB_PATH=path.join(root,'evaluation.db');
process.env.AIKOMBINAT_LOG_DIR=path.join(root,'logs');
const { getDatabase,closeDatabase }=await import('../src/server/db/connection.js');
const { getConsensusAnalytics,parseEvaluationFilters }=await import('../src/server/services/consensus-analytics.js');
try {
  const db=getDatabase();
  const projects=db.prepare('SELECT DISTINCT t.project_id FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id').all() as { project_id: string }[];
  const report={ source: path.resolve(sourcePath),copy: process.env.DB_PATH,foreignKeyCheck: db.pragma('foreign_key_check'),projects: projects.map(p=>{
    const data=getConsensusAnalytics(p.project_id,parseEvaluationFilters({ period: 'all' }));
    return { projectId: p.project_id,summary: data.summary,coverage: data.coverage,batches: data.batches.map(b=>({ id: b.id,status: b.status,finalVerdict: b.finalVerdict,agreement: b.agreement,reviewerCount: b.reviewerCount,successfulReviewers: b.successfulReviewers,failedReviewers: b.failedReviewers,diversity: b.diversity,telemetry: b.telemetry })) };
  }) };
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
} finally { closeDatabase(); }

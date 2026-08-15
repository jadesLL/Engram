import cron from 'node-cron';
import { getSetting } from '../lib/db.js';
import { runDreamCycle } from './tasks.js';

let task: cron.ScheduledTask | null = null;

/** 按设置启动/重启梦境整理调度（cron 表达式，默认每天 03:00） */
export function scheduleDreamCycle() {
  task?.stop();
  const expr = getSetting('dream_cron') || '0 3 * * *';
  const enabled = (getSetting('dream_enabled') ?? '1') !== '0';
  if (!enabled || !cron.validate(expr)) return;
  task = cron.schedule(expr, async () => {
    try {
      const result = await runDreamCycle();
      console.log('[dream] cycle done:', result);
    } catch (e) {
      console.error('[dream] cycle failed:', e);
    }
  });
  console.log(`[dream] scheduled: ${expr}`);
}

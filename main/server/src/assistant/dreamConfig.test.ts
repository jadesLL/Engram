import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 梦境思考的排期数学。
 *
 * 用户要的是「每天几点」或「每隔几天几点」——不是 cron，所以口径必须钉死在这几条：
 *   - 计划时刻严格晚于基准（正好压在计划点上算下一次，避免原地重复跑）；
 *   - 基准 = 上次实际跑完的时刻与本次启用时刻取较晚者（关机错过的计划在下次启动补跑）；
 *   - 错过多次也只补一次（下次到期按上次实际运行推算，不会连着一串）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dream-config-'));
process.env.DATA_DIR = temp;

let kernel: typeof import('./dreamConfig.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  kernel = await import('./dreamConfig.js');
});

beforeEach(() => {
  db.prepare(`DELETE FROM settings WHERE key IN (?, ?)`)
    .run(kernel.DREAM_SETTINGS_KEY, kernel.DREAM_STATE_KEY);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 每天 03:00 的启用配置 */
function daily(patch: Partial<import('./dreamConfig.js').DreamConfig> = {}) {
  return kernel.normalizeDreamConfig({ enabled: true, frequency: 'daily', time: '03:00', ...patch });
}

/** 带锚点的状态（锚点=启用时刻） */
function anchored(at: Date) {
  return { ...kernel.EMPTY_DREAM_STATE, anchorAt: at.toISOString() };
}

test('parseClock：规范化写法与非法值', () => {
  assert.equal(kernel.parseClock('3:00'), '03:00');
  assert.equal(kernel.parseClock('03:05'), '03:05');
  assert.equal(kernel.parseClock('  23:59 '), '23:59');
  assert.equal(kernel.parseClock('0:00'), '00:00');
  assert.equal(kernel.parseClock('24:00'), null);
  assert.equal(kernel.parseClock('3:5'), null);
  assert.equal(kernel.parseClock('3:00:00'), null);
  assert.equal(kernel.parseClock(''), null);
  assert.equal(kernel.parseClock(undefined), null);
});

test('normalizeDreamConfig：认不出的值退回默认，enabled 只认 true', () => {
  assert.deepEqual(kernel.normalizeDreamConfig(undefined), kernel.DEFAULT_DREAM_CONFIG);
  assert.deepEqual(kernel.normalizeDreamConfig('坏数据'), kernel.DEFAULT_DREAM_CONFIG);
  assert.deepEqual(
    kernel.normalizeDreamConfig({ enabled: 'yes', frequency: 'weekly', time: '99:99', intervalDays: 0 }),
    { enabled: false, frequency: 'daily', time: '03:00', intervalDays: 1 },
  );
  // 间隔天数收敛到 [1, 30]，小数向下取整
  assert.deepEqual(
    kernel.normalizeDreamConfig({ enabled: true, frequency: 'interval', time: '22:30', intervalDays: 99 }),
    { enabled: true, frequency: 'interval', time: '22:30', intervalDays: 30 },
  );
  assert.equal(kernel.clampDreamIntervalDays(2.7), 2);
  assert.equal(kernel.clampDreamIntervalDays(-5), 1);
});

test('describeSchedule：两种频率各一句中文说法', () => {
  assert.equal(kernel.describeSchedule(daily()), '每天 03:00');
  assert.equal(
    kernel.describeSchedule(kernel.normalizeDreamConfig({ frequency: 'interval', intervalDays: 3, time: '23:30' })),
    '每隔 3 天 23:30',
  );
});

test('firstOccurrenceAfter（每天）：当天这个点没过就用今天，过了用明天', () => {
  const config = daily();
  assert.equal(
    +kernel.firstOccurrenceAfter(config, new Date(2026, 8, 27, 1, 0)),
    +new Date(2026, 8, 27, 3, 0),
  );
  assert.equal(
    +kernel.firstOccurrenceAfter(config, new Date(2026, 8, 27, 9, 0)),
    +new Date(2026, 8, 28, 3, 0),
  );
  // 正好压在计划时刻上算下一次：否则同一天会原地再跑一轮
  assert.equal(
    +kernel.firstOccurrenceAfter(config, new Date(2026, 8, 27, 3, 0)),
    +new Date(2026, 8, 28, 3, 0),
  );
  // 跨月：9/30 → 10/1
  assert.equal(
    +kernel.firstOccurrenceAfter(config, new Date(2026, 8, 30, 9, 0)),
    +new Date(2026, 9, 1, 3, 0),
  );
});

test('firstOccurrenceAfter（每隔 N 天）：从基准那天再隔 N 天的这个点', () => {
  const config = kernel.normalizeDreamConfig({ enabled: true, frequency: 'interval', intervalDays: 3, time: '03:00' });
  assert.equal(
    +kernel.firstOccurrenceAfter(config, new Date(2026, 8, 27, 20, 0)),
    +new Date(2026, 8, 30, 3, 0),
  );
  // 跨月同样按自然日推算
  assert.equal(
    +kernel.firstOccurrenceAfter(config, new Date(2026, 8, 30, 9, 0)),
    +new Date(2026, 9, 3, 3, 0),
  );
});

test('到期判断：启用后按计划到点；没启用永不跑', () => {
  const config = daily();
  const state = anchored(new Date(2026, 8, 27, 1, 0));
  assert.equal(kernel.isDreamDue(config, state, new Date(2026, 8, 27, 2, 0)), false);
  assert.equal(kernel.isDreamDue(config, state, new Date(2026, 8, 27, 3, 0)), true);
  assert.equal(kernel.isDreamDue(config, state, new Date(2026, 8, 27, 3, 0, 30)), true);
  assert.equal(kernel.isDreamDue({ ...config, enabled: false }, state, new Date(2026, 8, 27, 3, 0)), false);
  assert.equal(kernel.nextDueAt({ ...config, enabled: false }, state, new Date(2026, 8, 27, 3, 0)), null);
});

test('关机错过的计划：下次启动补跑一次，之后按实际运行时刻重排', () => {
  const config = daily();
  const state = anchored(new Date(2026, 8, 24, 1, 0)); // 三天前 01:00 启用，之后一直关机
  const wake = new Date(2026, 8, 27, 9, 0);
  assert.equal(kernel.isDreamDue(config, state, wake), true, '错过计划点应补跑');
  assert.equal(
    +kernel.nextDueAt(config, state, wake)!,
    +new Date(2026, 8, 24, 3, 0),
    '到期时刻是过去那个计划点（补跑一次，不是补跑一串）',
  );

  const afterRun = { ...state, lastRunAt: wake.toISOString() };
  assert.equal(+kernel.nextDueAt(config, afterRun, wake)!, +new Date(2026, 8, 28, 3, 0));
  assert.equal(kernel.isDreamDue(config, afterRun, wake), false);
});

test('从没启用过（没有锚点也没有历史）：不立刻补跑，从此刻算下一个计划', () => {
  const config = daily();
  const now = new Date(2026, 8, 27, 9, 0);
  assert.equal(+kernel.nextDueAt(config, kernel.EMPTY_DREAM_STATE, now)!, +new Date(2026, 8, 28, 3, 0));
  assert.equal(kernel.isDreamDue(config, kernel.EMPTY_DREAM_STATE, now), false);
});

test('每隔 N 天：锚点决定首跑日，跑完再隔 N 天', () => {
  const config = kernel.normalizeDreamConfig({ enabled: true, frequency: 'interval', intervalDays: 3, time: '03:00' });
  const anchor = new Date(2026, 8, 27, 9, 0);
  const state = anchored(anchor);
  assert.equal(+kernel.nextDueAt(config, state, anchor)!, +new Date(2026, 8, 30, 3, 0));
  assert.equal(kernel.isDreamDue(config, state, new Date(2026, 8, 29, 23, 0)), false);
  assert.equal(kernel.isDreamDue(config, state, new Date(2026, 8, 30, 3, 0)), true);

  const afterRun = { ...state, lastRunAt: new Date(2026, 8, 30, 3, 40).toISOString() };
  assert.equal(+kernel.nextDueAt(config, afterRun, new Date(2026, 8, 30, 4, 0))!, +new Date(2026, 9, 3, 3, 0));
});

test('保存配置：计划变化才重置排期锚点，只重复保存不会把当晚的计划推走', () => {
  const first = new Date(2026, 8, 27, 1, 0);
  kernel.writeDreamConfig({ enabled: true, frequency: 'daily', time: '03:00' }, first);
  assert.equal(kernel.readDreamState().anchorAt, first.toISOString());

  const later = new Date(2026, 8, 27, 2, 0);
  kernel.writeDreamConfig({ enabled: true, time: '03:00' }, later);
  assert.equal(kernel.readDreamState().anchorAt, first.toISOString(), '同计划重复保存不该重排');

  kernel.writeDreamConfig({ enabled: true, time: '04:00' }, later);
  assert.equal(kernel.readDreamState().anchorAt, later.toISOString(), '改了时间点要按新计划重排');

  kernel.writeDreamConfig({ enabled: false }, later);
  assert.equal(kernel.readDreamConfig().enabled, false);
  assert.equal(kernel.readDreamState().anchorAt, later.toISOString(), '关掉再开也算计划变化，但关闭本身也要落锚点');
});

test('状态读写：坏 JSON 退回空状态，写完能读回', () => {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(kernel.DREAM_STATE_KEY);
  assert.deepEqual(kernel.readDreamState(), kernel.EMPTY_DREAM_STATE);
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)`).run(kernel.DREAM_STATE_KEY, '{坏 JSON');
  assert.deepEqual(kernel.readDreamState(), kernel.EMPTY_DREAM_STATE);

  kernel.writeDreamState({ lastStatus: 'completed', lastSummary: '干完了', beforePendingFiles: 3 });
  const state = kernel.readDreamState();
  assert.equal(state.lastStatus, 'completed');
  assert.equal(state.lastSummary, '干完了');
  assert.equal(state.beforePendingFiles, 3);
  assert.equal(kernel.readDreamConfig().time, '03:00', '状态与配置分两个键，互不覆盖');
});

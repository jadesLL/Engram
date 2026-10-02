import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDEA_DISTILL_KIND,
  ideaDisplayTitle,
  ideaDistillRowStatus,
  ideaStageLabel,
  latestIdeaDistillJob,
  type IdeaDistillJobLike,
} from './ideaDistill.ts';

/**
 * 侧栏「灵感碎片」行状态映射的护栏。
 *
 * 这一层是纯函数（不碰 DOM/网络），坏掉的表现是「文件旁边一直转圈」或「提炼失败看不见」，
 * 都是用户没法自查的静默故障，所以把匹配口径（精确路径、多任务取最新、哪些状态该标）钉死在这里。
 */

const IDEA_PATH = '原始资料/灵感碎片/2026.10.01_随手记.md';

function job(id: number, path: string, status: string, kind = IDEA_DISTILL_KIND): IdeaDistillJobLike {
  return { id, kind, status, payload: { path } };
}

test('没有任务 / 空 feed：不标任何状态', () => {
  assert.equal(ideaDistillRowStatus(IDEA_PATH, undefined), null);
  assert.equal(ideaDistillRowStatus(IDEA_PATH, null), null);
  assert.equal(ideaDistillRowStatus(IDEA_PATH, { active: [], recent: [] }), null);
  // 缺 path（还没加载完页面）不能拿整库任务去瞎猜
  assert.equal(ideaDistillRowStatus('', { active: [job(1, '', 'running')] }), null);
});

test('payload.path 精确匹配：前缀相同的兄弟文件、别的 kind 都不算', () => {
  const feed = {
    active: [
      job(1, '原始资料/灵感碎片/2026.10.01_随手记（二）.md', 'running'),
      job(2, IDEA_PATH, 'running', 'extract_file'),
      job(3, '原始资料/文档/2026.10.01_随手记.md', 'running'),
    ],
    recent: [],
  };
  assert.equal(ideaDistillRowStatus(IDEA_PATH, feed), null);
  assert.equal(latestIdeaDistillJob(IDEA_PATH, feed), null);
  // 自己那条在 recent 里也要能认出来（服务端 active 只留 pending/running/paused）
  assert.equal(
    ideaDistillRowStatus(IDEA_PATH, { active: [], recent: [job(9, IDEA_PATH, 'failed')] })?.label,
    '提炼失败',
  );
});

test('多任务取最新：重试后的 running 压过旧的 failed；最新的 done 不再标', () => {
  const feed = {
    // active 按 id 升序、recent 按 id 降序（服务端 ORDER BY），这里故意打乱顺序喂进去
    active: [job(11, IDEA_PATH, 'running'), job(4, IDEA_PATH, 'failed')],
    recent: [job(7, IDEA_PATH, 'failed'), job(2, IDEA_PATH, 'running')],
  };
  assert.equal(latestIdeaDistillJob(IDEA_PATH, feed)?.id, 11);
  assert.equal(ideaDistillRowStatus(IDEA_PATH, feed)?.kind, 'running');

  // 提炼完成后（done）不再加徽标：文件行已有「已提炼」口径，双标会让人以为还在跑
  const finished = { active: [], recent: [job(12, IDEA_PATH, 'done'), job(11, IDEA_PATH, 'running')] };
  assert.equal(ideaDistillRowStatus(IDEA_PATH, finished), null);
  // 反过来：最新一条失败、更老的还在 running，也该显示失败（当前状态以最新任务为准）
  const failedAgain = { active: [job(20, IDEA_PATH, 'failed')], recent: [job(11, IDEA_PATH, 'running')] };
  assert.equal(ideaDistillRowStatus(IDEA_PATH, failedAgain)?.label, '提炼失败');
});

test('只有 running/failed 出徽标，pending/paused/取消/done 一律不标', () => {
  for (const status of ['running', 'failed']) {
    const row = ideaDistillRowStatus(IDEA_PATH, { active: [job(1, IDEA_PATH, status)] });
    assert.ok(row, `${status} 应该有行状态`);
    assert.equal(row.kind, status);
  }
  for (const status of ['pending', 'paused', 'done', 'cancelled']) {
    assert.equal(
      ideaDistillRowStatus(IDEA_PATH, { active: [job(1, IDEA_PATH, status)] }),
      null,
      `${status} 不该在灵感行上加徽标`,
    );
  }
});

test('展示标题去掉 YYYY.MM.DD_ 前缀，编辑态的真实标题不受影响', () => {
  assert.equal(ideaDisplayTitle('2026.10.01_随手记'), '随手记');
  assert.equal(ideaDisplayTitle('2026.1.5 京东四向车电机过载要求'), '京东四向车电机过载要求');
  assert.equal(ideaDisplayTitle('2026-10-01_随手记'), '随手记');
  // 已经去掉前缀（frontmatter 标题）的原样返回
  assert.equal(ideaDisplayTitle('京东四向车电机过载要求'), '京东四向车电机过载要求');
  // 整串只有日期时别展示成空标题
  assert.equal(ideaDisplayTitle('2026.10.01_'), '2026.10.01_');
  assert.equal(ideaDisplayTitle(''), '');
  assert.equal(ideaDisplayTitle(undefined), '');
});

test('提炼状态文案兜底：未知/空值都落到「未提炼」', () => {
  assert.equal(ideaStageLabel('done'), '已提炼');
  assert.equal(ideaStageLabel('skipped-edit'), '已跳过改写');
  assert.equal(ideaStageLabel('failed'), '提炼失败');
  assert.equal(ideaStageLabel('running'), '提炼中');
  assert.equal(ideaStageLabel(''), '未提炼');
  assert.equal(ideaStageLabel(null), '未提炼');
  assert.equal(ideaStageLabel('某种新状态'), '未提炼');
});

// 更新下载进度纯逻辑单测（lib/update-progress.js）
//
// 背景：2026-11-08 用户报「开着自动更新，设置页那块进度来回乱跳」——自动更新与手动
// 「下载并安装」落盘到同一个文件名，进度又共用一条 IPC 通道，两个下载同时跑时百分比
// 互相覆盖。这里锁住三条约定：百分比收敛、广播节流（含「进度回退必须发」）、事件带来源。
const test = require('node:test');
const assert = require('node:assert/strict');

const progress = require('../lib/update-progress');
const { clampPercent, nextProgressPublish, progressPayload, AUTO_PROGRESS_MIN_INTERVAL_MS } = progress;

test('clampPercent：非数字给 null，越界收敛到 0–100，小数四舍五入', () => {
  assert.equal(clampPercent(null), null);
  assert.equal(clampPercent(undefined), null);
  assert.equal(clampPercent(''), null);
  assert.equal(clampPercent('abc'), null);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(120), 100);
  assert.equal(clampPercent(39.6), 40);
  assert.equal(clampPercent('42'), 42);
});

test('nextProgressPublish：首次发，之后同值不发，间隔内变化不发，到间隔才发', () => {
  const first = nextProgressPublish(null, 1, 1000);
  assert.equal(first.publish, true);
  assert.deepEqual(first.previous, { percent: 1, at: 1000 });

  const same = nextProgressPublish(first.previous, 1, 1100);
  assert.equal(same.publish, false);
  assert.deepEqual(same.previous, { percent: 1, at: 1000 }); // 时间戳不能因为未发布而推进

  const tooSoon = nextProgressPublish(first.previous, 2, 1100);
  assert.equal(tooSoon.publish, false);

  const afterInterval = nextProgressPublish(first.previous, 2, 1000 + AUTO_PROGRESS_MIN_INTERVAL_MS);
  assert.equal(afterInterval.publish, true);
  assert.deepEqual(afterInterval.previous, { percent: 2, at: 1000 + AUTO_PROGRESS_MIN_INTERVAL_MS });
});

test('nextProgressPublish：进度回退（新一轮下载）与 100% 必须立刻发，不能被节流吞掉', () => {
  const prev = { percent: 100, at: 5000 };
  const restarted = nextProgressPublish(prev, 3, 5010);
  assert.equal(restarted.publish, true, '回退说明开始了新一轮下载，界面必须立刻回到真实进度');

  const done = nextProgressPublish({ percent: 60, at: 5000 }, 100, 5010);
  assert.equal(done.publish, true, '完成时状态行与进度条要立刻到 100%');
});

test('nextProgressPublish：percent 为 null（总长度未知）不广播，也不污染上一次时间戳', () => {
  const result = nextProgressPublish({ percent: 40, at: 900 }, null, 2000);
  assert.equal(result.publish, false);
  assert.deepEqual(result.previous, { percent: 40, at: 900 });
});

test('progressPayload：统一负载并标记来源，坏数据不抛错', () => {
  assert.deepEqual(progressPayload({ received: 1024, total: 2048, percent: 50.4 }, 'manual'), {
    received: 1024,
    total: 2048,
    percent: 50,
    source: 'manual',
  });
  assert.deepEqual(progressPayload({ received: 1, total: 0, percent: null }, 'auto'), {
    received: 1,
    total: 0,
    percent: null,
    source: 'auto',
  });
  assert.equal(progressPayload(null, 'other').source, 'manual', '未知来源一律按手动处理（旧壳没有来源字段）');
  assert.equal(progressPayload({ received: 'bad' }, 'manual').received, 0);
});

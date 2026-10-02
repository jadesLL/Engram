/**
 * 「记一条灵感」对话框的单态状态机：写（writing）→ 落盘（saving）→ 已记下待关框（queued），
 * 外加按钮三拍文案。
 *
 * 口径变化（2026-10，见 docs/IDEA-DISTILL-SPEC.md 4.3）：**删掉了「看一眼再记」的预览态**
 * 与随之而来的 `previewIdeaComposer / confirmIdeaComposer / backToEdit / canConfirmIdea /
 * draft / draftTitle / draftText`，以及只服务于预览的勘误/精炼摘要（`summarizeIdeaFixes /
 * summarizeIdeaRefine / summarizeIdeaChange`）——那些文案现在由后台提炼的通知统一说
 * （lib/ideaDistillFeed.ts）。所以旧文件里针对预览态与摘要的用例整体删除，不在这里保留。
 *
 * 本文件只测纯逻辑：落盘请求由测试注入的假 saver 代替，状态机保持无定时器——`queued` 那 1.2 秒
 * 的自动关框计时放在组件里（components/ui/IdeaComposer.vue），这里只锁「关框必须回传结果」。
 * 组件本身没法在 node 里挂载，所以最后两条用例沿用 androidUiFit.test.ts 的写法：读源码断言
 * 关键声明（只剩一个输入框、窄屏按钮不换行、正文框自己滚）。
 * 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDEA_MAX_CHARS,
  IDEA_QUEUED_AUTO_CLOSE_MS,
  canSubmitIdea,
  closeIdeaComposer,
  ideaComposerState,
  ideaSubmitLabel,
  isIdeaSubmitKey,
  openIdeaComposer,
  submitIdeaComposer,
  type SubmittedIdea,
} from './ideaComposer.ts';

/** 服务端落盘返回体（只留前端要用的四个字段） */
const saved: SubmittedIdea = {
  id: 'p1',
  path: '原始资料/灵感碎片/2026.10.01_随手记.md',
  title: '随手记',
  jobId: 123,
};

/** 每个用例从干净状态开始：对话框关着、没有草稿、没有残留错误 */
function resetComposer() {
  closeIdeaComposer(null);
  ideaComposerState.content = '';
  ideaComposerState.error = '';
}

/** 造一个「卡住的落盘」：返回闸门 + 放行函数，用来观察请求在途时的状态 */
function gate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

test('正文可提交判定：空白不算内容，超长不提交', () => {
  assert.equal(canSubmitIdea(''), false);
  assert.equal(canSubmitIdea('   \n  '), false);
  assert.equal(canSubmitIdea('一句话'), true);
  assert.equal(canSubmitIdea('字'.repeat(IDEA_MAX_CHARS)), true);
  assert.equal(canSubmitIdea('字'.repeat(IDEA_MAX_CHARS + 1)), false);
});

test('Ctrl/Cmd + Enter 才提交：多行输入框里回车要留给换行', () => {
  assert.equal(isIdeaSubmitKey({ key: 'Enter', ctrlKey: true, metaKey: false }), true);
  assert.equal(isIdeaSubmitKey({ key: 'Enter', ctrlKey: false, metaKey: true }), true);
  assert.equal(isIdeaSubmitKey({ key: 'Enter', ctrlKey: false, metaKey: false }), false);
  assert.equal(isIdeaSubmitKey({ key: 'Escape', ctrlKey: true, metaKey: false }), false);
});

test('按钮三拍文案：记下来 → 正在记下… → 已记下，正在后台提炼', () => {
  assert.equal(ideaSubmitLabel({ phase: 'writing', busy: false }), '记下来');
  assert.equal(ideaSubmitLabel({ phase: 'saving', busy: true }), '正在记下…');
  // busy 与 phase 理论上同步；任一个说「在落盘」就显示第二拍，不给用户再点一次的机会
  assert.equal(ideaSubmitLabel({ phase: 'saving', busy: false }), '正在记下…');
  assert.equal(ideaSubmitLabel({ phase: 'queued', busy: false }), '已记下，正在后台提炼');
});

test('第三拍只作短暂确认：自动关框时长在 1~1.5 秒之间（停久了等于又让用户多等一次）', () => {
  assert.ok(
    IDEA_QUEUED_AUTO_CLOSE_MS >= 1000 && IDEA_QUEUED_AUTO_CLOSE_MS <= 1500,
    `自动关框时长 ${IDEA_QUEUED_AUTO_CLOSE_MS}ms 不在「短暂确认」区间内`
  );
});

test('落盘：正文 trim 后原样送服务端，在途是第二拍、成功后进第三拍（框还开着等自动关）', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '  就是那个啊，北子所想确认样车尺寸。  ';
  const sent: string[] = [];
  const { gate: saving, release } = gate();
  const submit = submitIdeaComposer(async (content) => {
    sent.push(content);
    await saving;
    return saved;
  });

  // 落盘在途：第二拍 + busy（这两条决定「取消」被禁用）
  assert.equal(ideaComposerState.phase, 'saving');
  assert.equal(ideaComposerState.busy, true);
  assert.equal(ideaSubmitLabel(ideaComposerState), '正在记下…');
  assert.deepEqual(sent, ['就是那个啊，北子所想确认样车尺寸。']);

  release();
  await submit;
  assert.equal(ideaComposerState.phase, 'queued');
  assert.equal(ideaComposerState.busy, false);
  assert.equal(ideaSubmitLabel(ideaComposerState), '已记下，正在后台提炼');
  assert.equal(ideaComposerState.open, true, '第三拍还停在框里，等自动关或用户点「好，去做别的」');

  closeIdeaComposer(null);
  assert.deepEqual(await pending, saved);
});

test('已落盘后关框（点 ✕ / Esc / 遮罩 / 安卓返回都传 null）：结果照旧回调，不丢', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '北子所想确认样车尺寸';
  await submitIdeaComposer(async () => saved);
  assert.equal(ideaComposerState.content, '北子所想确认样车尺寸', '第三拍还看得见刚记的原文');

  // 安卓返回键走的正是 closeIdeaComposer(null)（lib/globalBackLayers.ts）：不能把结果弄丢
  closeIdeaComposer(null);
  assert.deepEqual(await pending, saved);
  assert.equal(ideaComposerState.open, false);
  assert.equal(ideaComposerState.phase, 'writing');
  assert.equal(ideaComposerState.content, '', '已落盘的那条不再当草稿留着');
});

test('落盘失败：留在第一拍、正文不丢、显示服务端原因；重试成功可进第三拍', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '写了一半就失败的灵感';
  await submitIdeaComposer(async () => {
    throw { response: { data: { error: '磁盘写满了' } } };
  });
  assert.equal(ideaComposerState.phase, 'writing');
  assert.equal(ideaComposerState.busy, false);
  assert.equal(ideaComposerState.error, '磁盘写满了');
  assert.equal(ideaComposerState.content, '写了一半就失败的灵感');

  await submitIdeaComposer(async () => saved);
  assert.equal(ideaComposerState.phase, 'queued');
  assert.equal(ideaComposerState.error, '', '重试成功后上一轮错误清掉');

  closeIdeaComposer(null);
  assert.deepEqual(await pending, saved);
});

test('服务端没回 id：当失败处理，不能停在第三拍骗用户「已记下」', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '没有 id 的响应';
  await submitIdeaComposer(async () => ({ ...saved, id: '' }));
  assert.equal(ideaComposerState.phase, 'writing');
  assert.match(ideaComposerState.error, /没有返回页面 id/);
  assert.equal(ideaComposerState.open, true);

  closeIdeaComposer(null);
  assert.equal(await pending, null, '没落盘就不能回传结果，调用方不该跳转');
});

test('空正文不发请求：直接返回，框留着', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '   ';
  let called = 0;
  await submitIdeaComposer(async () => {
    called += 1;
    return saved;
  });
  assert.equal(called, 0);
  assert.equal(ideaComposerState.open, true);
  assert.equal(ideaComposerState.phase, 'writing');

  closeIdeaComposer(null);
  assert.equal(await pending, null);
});

test('落盘在途不许取消：迟到的结果仍能投回调用方（安卓返回键走的这条路径）', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '北子所想确认样车尺寸';
  const { gate: saving, release } = gate();
  const submit = submitIdeaComposer(async () => {
    await saving;
    return saved;
  });
  assert.equal(ideaComposerState.busy, true);

  closeIdeaComposer(null);
  assert.equal(ideaComposerState.open, true, '在途取消无效：框留着，别把结果投丢');

  release();
  await submit;
  assert.equal(ideaComposerState.phase, 'queued');
  closeIdeaComposer(null);
  assert.deepEqual(await pending, saved);
});

test('落盘在途时再开一次（Ctrl+N 连按）：复用同一次会话，不重置成第一拍', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '北子所想确认样车尺寸';
  const { gate: saving, release } = gate();
  const submit = submitIdeaComposer(async () => {
    await saving;
    return saved;
  });

  const again = openIdeaComposer();
  release();
  await submit;
  assert.equal(ideaComposerState.phase, 'queued', '在途时的第二次打开不该重置状态');
  assert.equal(again, pending, '复用同一个会话 promise');

  closeIdeaComposer(null);
  assert.deepEqual(await pending, saved);
});

test('取消（还没落盘就关框）：返回 null，正文留着下次接着写', async () => {
  resetComposer();
  const pending = openIdeaComposer();
  ideaComposerState.content = '下次接着写的内容';
  closeIdeaComposer(null);
  assert.equal(await pending, null);
  assert.equal(ideaComposerState.open, false);
  assert.equal(ideaComposerState.phase, 'writing');
  assert.equal(ideaComposerState.content, '下次接着写的内容');
});

test('落盘成功后重新打开：新会话是干净的一拍，上一条的结果不会串进来', async () => {
  resetComposer();
  const first = openIdeaComposer();
  ideaComposerState.content = '第一条';
  await submitIdeaComposer(async () => saved);
  closeIdeaComposer(null);
  assert.equal((await first)?.id, 'p1');

  const second = openIdeaComposer();
  assert.equal(ideaComposerState.phase, 'writing');
  assert.equal(ideaComposerState.content, '');
  assert.equal(ideaComposerState.error, '');
  closeIdeaComposer(null);
  assert.equal(await second, null, '新会话没落盘就是 null，不该拿到上一条的结果');
});

test('已落盘（第三拍）时又按 Ctrl+N：先把上一个结果投递掉，再开新会话，两次结果不混', async () => {
  resetComposer();
  const first = openIdeaComposer();
  ideaComposerState.content = '第一条';
  await submitIdeaComposer(async () => saved);
  assert.equal(ideaComposerState.phase, 'queued');

  const second = openIdeaComposer();
  assert.deepEqual(await first, saved, '第一次记的结果不能因为重开而丢');
  assert.equal(ideaComposerState.open, true);
  assert.equal(ideaComposerState.phase, 'writing');
  assert.equal(ideaComposerState.content, '');

  ideaComposerState.content = '第二条';
  await submitIdeaComposer(async () => ({ ...saved, id: 'p2' }));
  closeIdeaComposer(null);
  assert.equal((await second)?.id, 'p2');
});

/* ---------------------------------------------------------------- 组件接线 */
/* 组件没法在 node 里挂载，沿用 androidUiFit.test.ts 的写法：读源码断言关键声明 */

const composerVue = () =>
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'components', 'ui', 'IdeaComposer.vue'), 'utf8');

test('对话框只剩一个正文输入框：预览态的字段与入口全删了', () => {
  const src = composerVue();
  assert.equal((src.match(/<textarea/g) ?? []).length, 1, '预览态那个正文框还在：用户又得先看一眼再记');
  assert.doesNotMatch(src, /draftText|draftTitle|isPreview|previewIdeaComposer|confirmIdeaComposer/);
  assert.match(src, /随手写，标题不用起/, '提示语没换成「不预览、后台整理」的口径');
});

test('窄屏（430px）可用：按钮排一行、键盘提示让位、正文框自己滚', () => {
  const src = composerVue();
  assert.match(
    src,
    /:deep\(\.app-modal-foot\)\s*\{[^}]*flex-wrap:\s*nowrap/,
    '底部按钮会换行：手机上「记下来」被挤到第二行'
  );
  assert.match(
    src,
    /@media \(max-width: 640px\)\s*\{[^}]*\.idea-keys\s*\{[^}]*display:\s*none/,
    '窄屏没给按钮腾位置（断点只能用规范三档 640/768/1024，见 mobileLayout.test.ts）'
  );
  assert.match(src, /\.idea-input\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/, '正文框没自己的滚动：内容长了会把按钮挤出视野');
  // 触屏上不显示键盘提示（与 lib/pointer.ts 同口径：手机横屏也够不着 Ctrl）
  assert.match(src, /useTouchPointer/, '没做触屏判断：手机上仍显示 Ctrl+Enter');
  assert.match(src, /v-if="!touchPointer"[\s\S]{0,80}idea-keys/, '触屏判断没接到键盘提示上');
});

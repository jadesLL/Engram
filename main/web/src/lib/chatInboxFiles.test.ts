import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatInboxFile } from '../stores/chat';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  MAX_CHAT_INBOX_FILES,
  chatInboxFileFromPath,
  chatInboxFileName,
  chatInboxFilesFromMetadata,
  chatInboxSourceLabel,
  composeChatInboxMessage,
  isInboxOriginalPath,
  mergeChatInboxFiles,
  preparePastedFiles,
  removeChatInboxFile,
} from './chatInboxFiles.ts';

/**
 * 对话里的收集箱附件：路径判定（与服务端同口径）、合并去重、默认话术、
 * 消息 metadata 重放与粘贴命名。界面层不再各写一份。
 */

test('isInboxOriginalPath：只认收集箱原件（真实转换产物/知识库文件都不算）', () => {
  assert.equal(isInboxOriginalPath('收集箱/合同.pdf'), true);
  assert.equal(isInboxOriginalPath('\\收集箱\\合同.pdf'), true);
  assert.equal(isInboxOriginalPath('/收集箱/随手记.md'), true);
  assert.equal(isInboxOriginalPath('收集箱/转换结果/2026.10.18_合同.md'), false);
  assert.equal(isInboxOriginalPath('原始资料/文档/a.md'), false);
  assert.equal(isInboxOriginalPath('收集箱备份/a.pdf'), false);
  assert.equal(isInboxOriginalPath('收集箱'), false);
  assert.equal(isInboxOriginalPath(''), false);
});

test('chatInboxFileName / chatInboxFileFromPath：补展示名、拒绝非法路径', () => {
  assert.equal(chatInboxFileName('收集箱/子目录/报价单 v2.xlsx'), '报价单 v2.xlsx');
  assert.equal(chatInboxFileName('收集箱\\照片.png'), '照片.png');
  assert.deepEqual(chatInboxFileFromPath('收集箱\\合同.pdf', 'upload'), {
    path: '收集箱/合同.pdf',
    name: '合同.pdf',
    source: 'upload',
  });
  assert.deepEqual(chatInboxFileFromPath('收集箱/合同.pdf', 'inbox', '  合同  '), {
    path: '收集箱/合同.pdf',
    name: '合同',
    source: 'inbox',
  });
  assert.equal(chatInboxFileFromPath('收集箱/转换结果/产物.md', 'inbox'), null);
  assert.equal(chatInboxFileFromPath('Wiki/概念/a.md', 'inbox'), null);
});

test('mergeChatInboxFiles：按路径去重、保持先来后到、封顶 20 条', () => {
  const first = chatInboxFileFromPath('收集箱/a.txt', 'upload')!;
  const second = chatInboxFileFromPath('收集箱/b.txt', 'inbox')!;
  const dup = chatInboxFileFromPath('收集箱/a.txt', 'inbox', '重复')!;
  assert.deepEqual(mergeChatInboxFiles([first], [second, dup]), [first, second]);

  const many = Array.from({ length: 25 }, (_, index) =>
    chatInboxFileFromPath(`收集箱/${index}.txt`, 'upload')!
  );
  assert.equal(mergeChatInboxFiles(many, []).length, MAX_CHAT_INBOX_FILES);
  assert.deepEqual(removeChatInboxFile(mergeChatInboxFiles([first, second], []), '收集箱/a.txt'), [second]);
});

test('composeChatInboxMessage：有草稿用草稿；只有附件时补默认任务话术', () => {
  const files = [
    chatInboxFileFromPath('收集箱/客户拜访要点.txt', 'upload', '客户拜访要点.txt')!,
    chatInboxFileFromPath('收集箱/报价单.xlsx', 'inbox')!,
  ];
  assert.equal(composeChatInboxMessage('  帮我总结  ', files), '帮我总结');
  const auto = composeChatInboxMessage('   ', files);
  // 文件名单不重复塞进正文（附件 chip 已列），但要点总结/产物留在收集箱的口径要在
  assert.match(auto, /我从收集箱附上了 2 份文件/);
  assert.match(auto, /3–5 条要点总结/);
  assert.match(auto, /产物留在收集箱，不要入库/);
  assert.equal(auto.includes('客户拜访要点.txt'), false);
  assert.equal(composeChatInboxMessage('', []), '');
});

test('chatInboxFilesFromMetadata：缺失/坏形状返回空；重放时规整路径与来源', () => {
  assert.deepEqual(chatInboxFilesFromMetadata(undefined), []);
  assert.deepEqual(chatInboxFilesFromMetadata({}), []);
  assert.deepEqual(chatInboxFilesFromMetadata({ inboxFiles: 'oops' }), []);
  assert.deepEqual(chatInboxFilesFromMetadata({ inboxFiles: [{}, { path: 3 }, { path: 'Wiki/x.md' }] }), []);

  const files = chatInboxFilesFromMetadata({
    inboxFiles: [
      { path: '\\收集箱\\合同.pdf', name: ' 合同 ', source: 'upload' },
      { path: '收集箱/转换结果/产物.md', source: 'upload' },
      { path: '收集箱/照片.png', source: 'bogus' },
    ],
  });
  assert.deepEqual(files, [
    { path: '收集箱/合同.pdf', name: '合同', source: 'upload' },
    { path: '收集箱/照片.png', name: '照片.png' },
  ]);
  assert.equal(chatInboxSourceLabel(files[0]), '新上传');
  assert.equal(chatInboxSourceLabel(files[1]), '新上传');
  assert.equal(chatInboxSourceLabel(chatInboxFileFromPath('收集箱/a.md', 'inbox')!), '收集箱');
});

test('preparePastedFiles：截图按时间命名，普通文件名保持原样', () => {
  const fixed = new Date(2026, 9, 21, 9, 5, 7);
  const png = new File([Buffer.from([0x89, 0x50])], 'image.png', { type: 'image/png' });
  const named = new File(['a'], '客户纪要.txt', { type: 'text/plain' });
  const [renamed, kept] = preparePastedFiles([png, named], fixed);
  assert.equal(renamed.name, '粘贴图片-20261021-090507.png');
  assert.equal(renamed.type, 'image/png');
  assert.equal(kept.name, '客户纪要.txt');
});

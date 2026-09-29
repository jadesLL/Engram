import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoUrl } from './repoSourceUrl.ts';

/**
 * 更新源仓库地址解析（服务器/桌面端「更新源配置」与安卓端「安卓端更新」共用）：
 * 用户习惯直接粘贴地址栏，得多容忍几种写法；但只给站点首页时必须明确报错，
 * 否则会保存一个永远查不到 Release 的地址。
 */

test('解析仓库首页地址与常见变体', () => {
  assert.deepEqual(parseRepoUrl('https://gitea.example.com/example/Engram'), {
    url: 'https://gitea.example.com',
    repo: 'example/Engram',
  });
  assert.deepEqual(parseRepoUrl('https://gitea.example.com/example/Engram/'), {
    url: 'https://gitea.example.com',
    repo: 'example/Engram',
  });
  assert.deepEqual(parseRepoUrl('https://gitea.example.com/example/Engram.git'), {
    url: 'https://gitea.example.com',
    repo: 'example/Engram',
  });
  // Release 页 / 分支页地址也直接可用；带端口的服务地址原样保留
  assert.deepEqual(parseRepoUrl('https://gitea.example.com:11111/example/Engram/releases'), {
    url: 'https://gitea.example.com:11111',
    repo: 'example/Engram',
  });
  // 缺协议按 https 补
  assert.deepEqual(parseRepoUrl('gitea.example.com/example/Engram'), {
    url: 'https://gitea.example.com',
    repo: 'example/Engram',
  });
});

test('只给站点首页 / 非法路径时给出可读的错误', () => {
  assert.match(String((parseRepoUrl('https://gitea.example.com') as { error: string }).error), /缺少仓库路径/);
  assert.match(String((parseRepoUrl('not a url') as { error: string }).error), /无法识别/);
  assert.match(
    String((parseRepoUrl('https://gitea.example.com/example/Engram 副本') as { error: string }).error),
    /无法识别的字符/,
  );
});

test('空输入表示「不配置」（跟随同步中枢下发的地址）', () => {
  assert.deepEqual(parseRepoUrl('   '), { url: '', repo: '' });
});

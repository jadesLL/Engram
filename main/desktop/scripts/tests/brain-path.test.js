const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBrainPath } = require('../../lib/brain-path');
const { joinLinkFromArgs, protocolRegistration } = require('../../lib/join-link');

test('本地目录与文件可定位，绝对路径、穿越、符号链接越界均拒绝', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-path-'));
  try {
    fs.mkdirSync(path.join(temp, 'brain', 'Wiki'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'brain', 'Wiki', '例子.md'), 'test');
    assert.equal(resolveBrainPath(temp, 'Wiki'), fs.realpathSync(path.join(temp, 'brain', 'Wiki')));
    assert.ok(resolveBrainPath(temp, 'Wiki/例子.md').endsWith('例子.md'));
    for (const bad of ['../outside', '/tmp', 'C:\\Windows', '\\\\server\\file', 'missing']) {
      assert.throws(() => resolveBrainPath(temp, bad));
    }
    fs.mkdirSync(path.join(temp, 'outside'));
    fs.symlinkSync(path.join(temp, 'outside'), path.join(temp, 'brain', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveBrainPath(temp, 'escape'), /路径越界/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('冷启动/第二实例链接过滤，源码与安装包协议注册参数', () => {
  const link = 'engram://join?hub=http%3A%2F%2Fhub&token=lsync_123';
  assert.equal(joinLinkFromArgs(['electron', '/app', link]), link);
  assert.equal(joinLinkFromArgs(['https://example.org', 'engram://other?x=1']), '');
  assert.deepEqual(protocolRegistration('/electron', '/app', true), ['engram', '/electron', ['/app']]);
  assert.deepEqual(protocolRegistration('/exe', '/app', false), ['engram']);
});

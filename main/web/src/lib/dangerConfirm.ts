import { confirmDialog, promptDialog } from './confirm';

/**
 * 危险操作的三段式确认：先确认动作 → 再输入登录密码 → 最后再确认一次。
 *
 * 备份恢复（DataPanel）与清库/清日志（DataDangerSection）共用同一套门禁：
 * 两处都是不可撤销操作，确认步骤必须一致，否则用户会以为「这个危险操作怎么少问了一遍」。
 *
 * 返回：
 *  - null            用户中途取消；
 *  - { error }       密码为空（调用方把文案显示在自己的消息位上）；
 *  - { password }    通过全部确认，密码交给接口校验。
 */
export async function confirmWithPassword(
  actionLabel: string,
): Promise<{ password: string } | { error: string } | null> {
  const first = await confirmDialog({
    title: '危险操作确认',
    message: `即将${actionLabel}，此操作不可撤销。确认继续？`,
    confirmText: '继续',
    danger: true,
  });
  if (!first) return null;
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog 收密码
  const password = await promptDialog({
    title: '身份确认',
    message: '请输入登录密码以确认：',
    placeholder: '登录密码',
    confirmText: '确认',
    danger: true,
  });
  if (password === null) return null;
  if (!password) return { error: '密码不能为空' };
  const second = await confirmDialog({
    title: '最后一次确认',
    message: `真的要${actionLabel}吗？`,
    confirmText: '确认执行',
    danger: true,
  });
  if (!second) return null;
  return { password };
}

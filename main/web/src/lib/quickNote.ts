/**
 * 快速记灵感：左下角「+」、首页卡片共用的一个入口。
 *
 * 落到 `原始资料/灵感碎片/`（原始资料的二级分类之一），文件名沿用全库命名约定
 * `YYYY.MM.DD_标题.md`；建完由调用方决定跳转（一般直接进编辑器接着写）。
 */
import { api } from '../api';
import { promptDialog } from './confirm';
import { notify } from './notify';

export interface IdeaNoteResult {
  id: string;
  path: string;
}

/** 本地日期前缀（与原始资料其它文件的命名一致） */
function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/** 弹出输入框 → 在「灵感碎片」建一份 Markdown；取消返回 null */
export async function createIdeaNote(): Promise<IdeaNoteResult | null> {
  const input = await promptDialog({
    title: '记一条灵感',
    message: '想到什么就先记一句（作为标题，内容进去再写）：',
    placeholder: '例如：北自所那边想确认一下样车尺寸',
    confirmText: '记下来',
  });
  if (input === null) return null;
  const title = String(input).trim().replace(/[\\/:*?"<>|]/g, '-') || '随手记';
  try {
    const { data } = await api.post('/api/files/create', {
      name: `${todayStamp()}_${title}.md`,
      section: 'idea',
    });
    notify.success('已记到「灵感碎片」');
    return { id: data.pageId, path: data.path };
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '记灵感失败，请重试');
    return null;
  }
}

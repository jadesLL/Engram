import path from 'node:path';
import fs from 'node:fs';

const cwd = process.cwd();

/** 数据根目录：容器内 /data，开发时为 server/data */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(cwd, 'data'));
/** Markdown 权威源目录（页面 + 附件 + 其他文件都在这里） */
export const BRAIN_DIR = path.join(DATA_DIR, 'brain');
/** 回收站 */
export const TRASH_DIR = path.join(BRAIN_DIR, '.trash');
/** 编辑器粘贴/上传的图片等内联资源 */
export const ASSETS_DIR = path.join(BRAIN_DIR, 'assets');
/** SQLite 数据库文件 */
export const DB_FILE = path.join(DATA_DIR, 'wiki.db');

export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || '0.0.0.0';

/** 固定目录结构（用户不可增删文件夹） */
export const FIXED_DIRS = [
  '原始资料',
  '原始资料/对话',
  'Wiki',
  'Wiki/概念',
  'Wiki/实体',
  'Wiki/查询',
  'Wiki/归档',
  'Wiki/关系',
  'AIWorks',
  'AIWorks/index',
  'AIWorks/log',
  'AIWorks/scheme',
] as const;

/** 允许新建/移入页面的目录（Wiki 树内） */
export const PAGE_DIRS = ['Wiki', 'Wiki/概念', 'Wiki/实体', 'Wiki/查询', 'Wiki/归档', 'Wiki/关系'] as const;

/** 允许上传文件的目录（原始资料 + 编辑器资源目录） */
export const UPLOAD_DIRS = ['原始资料', 'assets'] as const;

export function normalizeDir(dir: string): string {
  return dir.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '').split('\\').join('/');
}

export function isPageDir(dir: string): boolean {
  return (PAGE_DIRS as readonly string[]).includes(normalizeDir(dir));
}

export function isUploadDir(dir: string): boolean {
  return (UPLOAD_DIRS as readonly string[]).includes(normalizeDir(dir));
}

/** 页面类型 → 物理目录映射（类型即目录；知识库只分概念/实体两类） */
const TYPE_DIR: Record<string, string> = {
  concept: 'Wiki/概念',
  person: 'Wiki/实体',
  project: 'Wiki/实体',
  org: 'Wiki/实体',
};

export function typeToDir(type: string): string {
  return TYPE_DIR[type] || 'Wiki/概念';
}

export const ARCHIVE_DIR = 'Wiki/归档';
export const QUERY_DIR = 'Wiki/查询';
export const AILOG_DIR = 'AIWorks/log';

export function ensureDirs() {
  for (const dir of [DATA_DIR, BRAIN_DIR, TRASH_DIR, ASSETS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const rel of FIXED_DIRS) {
    fs.mkdirSync(path.join(BRAIN_DIR, rel), { recursive: true });
  }
}

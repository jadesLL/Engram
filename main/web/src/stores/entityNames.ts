import { defineStore } from 'pinia';
import { api } from '../api';

/**
 * 公司全名核验（外部 Agent 经 MCP entity_name_check / CLI names check 登记，用户在这里答复）。
 *
 * 两轮请示共用一个面板：
 *  1. query_consent —— 资料库里没有工商全名，问「是否允许联网查企查查/天眼查」；
 *  2. rename_consent —— Agent 查到全名了，问「是否把页面标题改成该全名」（同意即由服务端改名）。
 * 未答复条数用于左栏角标；SSE 收到 entity-name 事件时刷新。
 */

export type EntityNameStage = 'query_consent' | 'lookup' | 'rename_consent' | 'closed';

export interface EntityNameCheck {
  id: string;
  /** 材料里的写法（待核名称，通常是简称） */
  entity: string;
  pageId: string;
  pagePath: string;
  pageTitle: string;
  stage: EntityNameStage;
  fullName: string;
  fullNameSource: string;
  note: string;
  queryConsent: '' | 'granted' | 'denied';
  renameConsent: '' | 'granted' | 'denied';
  outcome: '' | 'kb_hit' | 'renamed' | 'kept_material' | 'no_full_name' | 'query_denied';
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
}

/** 已办结条目的结论（面板「已办结」区展示） */
export function outcomeLabel(check: EntityNameCheck): string {
  switch (check.outcome) {
    case 'kb_hit': return `资料库已有全名：${check.fullName}`;
    case 'renamed': return `已改用全名：${check.fullName}`;
    case 'kept_material': return '你选择保持材料写法';
    case 'no_full_name': return '联网查询未找到全名';
    case 'query_denied': return '你不同意联网查询';
    default: return '已办结';
  }
}

export const useEntityNamesStore = defineStore('entityNames', {
  state: () => ({
    items: [] as EntityNameCheck[],
    /** 等用户答复的条数（角标） */
    pending: 0,
    loading: false,
    loaded: false,
  }),
  actions: {
    async refresh() {
      this.loading = true;
      try {
        const { data } = await api.get('/api/entity-names', { params: { status: 'all' } });
        this.items = data.checks || [];
        this.pending = data.pending ?? 0;
        this.loaded = true;
      } catch {
        /* 保留上次状态：角标不因一次失败闪没 */
      } finally {
        this.loading = false;
      }
    },
    /** 答复：allow=允许联网查询 / 同意改用全名；deny=不同意（保持材料写法） */
    async answer(id: string, decision: 'allow' | 'deny', note = '') {
      const { data } = await api.post(`/api/entity-names/${encodeURIComponent(id)}/answer`, {
        decision,
        note,
      });
      await this.refresh();
      return data.check as EntityNameCheck;
    },
  },
});

/**
 * 会话来源徽标（对话抽屉的会话列表）：一眼看出这个会话是在哪台设备上产生的。
 *
 * 口径（2026-10 校正）：
 *  - **本机产生的会话也标出来**（「本机」），不再只在别端会话上挂徽标；
 *  - 别端来的标「来自 <设备>」，名字取**中枢配置里的成员名**（服务端 resolveOriginLabel 解析后
 *    随会话行下发），不是电脑主机名——Docker 上主机名是容器 ID、桌面端上是机器名；
 *  - 本机节点 id 还没取到（未参与同步 / 同步状态未就绪）时一律不标：宁可少一个徽标，也不要误标。
 */

export interface SessionSourceInput {
  originNodeId?: string;
  originNodeLabel?: string;
}

export interface SessionSourceBadge {
  kind: 'local' | 'foreign';
  /** 徽标文字：本机 / 来自 <设备> */
  text: string;
  tooltip: string;
}

/**
 * 别端设备名：旧版中枢的广播只带了来源节点 id、没带名字（历史行里是空的）时退化成
 * 「其他设备」——宁可说不知道，也不要渲染出一个光秃秃的「来自」。
 */
export function foreignDeviceName(session: SessionSourceInput): string {
  return String(session.originNodeLabel || '').trim() || '其他设备';
}

/**
 * @param localNodeId 本机节点 id（空 = 同步没参与或状态还没到，返回 null 不标徽标）
 * @param localName   本机在中枢配置里的名字（用于工具提示，可空）
 */
export function sessionSourceBadge(
  session: SessionSourceInput,
  localNodeId?: string,
  localName?: string,
): SessionSourceBadge | null {
  const nodeId = String(localNodeId || '').trim();
  if (!nodeId) return null;
  const origin = String(session.originNodeId || '').trim();
  const self = String(localName || '').trim();
  if (!origin || origin === nodeId) {
    return {
      kind: 'local',
      text: '本机',
      tooltip: self
        ? `这个会话是在本机（${self}）上产生的；别的设备看到的是「来自 ${self}」`
        : '这个会话是在这台设备上产生的',
    };
  }
  const name = foreignDeviceName(session);
  return {
    kind: 'foreign',
    text: `来自 ${name}`,
    tooltip: `这个会话是「${name}」上产生的，内容已同步到本机`,
  };
}

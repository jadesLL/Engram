/** 中枢签发、成员消费同一条配对链接；完整令牌不进入日志。 */
export interface PairingInvite { hubUrl: string; token: string; name: string }

export function parsePairingLink(raw: unknown): PairingInvite | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  const candidate = raw.trim().match(/engram:\/\/join\?[^\s"'<>“”（）()【】]+/i)?.[0];
  if (!candidate) return null;
  try {
    const link = new URL(candidate);
    const hub = new URL(link.searchParams.get('hub') || '');
    const token = link.searchParams.get('token') || '';
    if (link.username || link.password || link.port || link.pathname) return null;
    if (!['http:', 'https:'].includes(hub.protocol) || !hub.hostname || hub.username || hub.password) return null;
    if (!/^[A-Za-z0-9._~+/=-]{6,200}$/.test(token)) return null;
    return { hubUrl: `${hub.protocol}//${hub.host}${hub.pathname.replace(/\/+$/, '')}`, token,
      name: (link.searchParams.get('name') || '').trim().slice(0, 40) };
  } catch { return null; }
}

export function pairingLink(invite: PairingInvite): string {
  const params = new URLSearchParams({ hub: invite.hubUrl, token: invite.token });
  if (invite.name) params.set('name', invite.name);
  params.set('v', '1');
  return `engram://join?${params}`;
}

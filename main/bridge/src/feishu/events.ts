/**
 * 飞书事件解析：处理 url_verification 校验挑战与 im.message.receive_v1 消息事件。
 *
 * 事件订阅 v2 schema 结构：
 *   { schema, header:{ event_id, event_type, token, ... }, event:{ sender, message } }
 * text 消息的 content 为 JSON 字符串 {"text":"..."}，群聊 @机器人 时含 @_user_N 前缀。
 */

export interface FeishuEvent {
  eventId: string;
  eventType: 'im.message.receive_v1';
  token: string;
  openId: string;
  messageId: string;
  chatId: string;
  messageType: string;
  text: string;
}

export interface UrlVerification {
  type: 'url_verification';
  challenge: string;
}

export type ParsedEvent = FeishuEvent | UrlVerification | null;

/** 移除群聊 @机器人 文本前缀（@_user_N 形式）。 */
function stripMention(text: string): string {
  return text.replace(/@_user_\d+/g, '').replace(/@\S+/g, '').trim();
}

export function parseEvent(rawJson: string): ParsedEvent {
  const obj = JSON.parse(rawJson) as Record<string, unknown>;

  if (obj['type'] === 'url_verification' && typeof obj['challenge'] === 'string') {
    return { type: 'url_verification', challenge: obj['challenge'] };
  }

  const header = obj['header'] as Record<string, unknown> | undefined;
  if (!header) return null;
  const eventType = String(header['event_type'] ?? '');
  if (eventType !== 'im.message.receive_v1') return null;

  const event = obj['event'] as Record<string, unknown> | undefined;
  if (!event) return null;
  const message = event['message'] as Record<string, unknown> | undefined;
  const sender = event['sender'] as Record<string, unknown> | undefined;
  if (!message || !sender) return null;

  const senderId = sender['sender_id'] as Record<string, unknown> | undefined;
  const openId = String(senderId?.['open_id'] ?? '');
  const messageId = String(message['message_id'] ?? '');
  const chatId = String(message['chat_id'] ?? '');
  const messageType = String(message['message_type'] ?? '');

  let text = '';
  if (messageType === 'text') {
    try {
      const content = JSON.parse(String(message['content'] ?? '{}')) as { text?: string };
      text = stripMention(String(content.text ?? ''));
    } catch {
      text = '';
    }
  } else {
    text = `[不支持的消息类型: ${messageType}]`;
  }

  return {
    eventId: String(header['event_id'] ?? ''),
    eventType,
    token: String(header['token'] ?? ''),
    openId,
    messageId,
    chatId,
    messageType,
    text,
  };
}

/** 类型守卫：是否为 url_verification 校验挑战。 */
export function isUrlVerification(e: ParsedEvent): e is UrlVerification {
  return e !== null && (e as UrlVerification).type === 'url_verification';
}

/** 类型守卫：是否为可处理的消息事件。 */
export function isFeishuEvent(e: ParsedEvent): e is FeishuEvent {
  return e !== null && (e as FeishuEvent).eventType === 'im.message.receive_v1';
}

/**
 * 飞书长连接（WebSocket）客户端。
 *
 * 协议（移植自官方 Node SDK ws-client/，零新依赖，Node 24 原生 WebSocket）：
 *   1. POST {apiBase}/callback/ws/endpoint {AppID, AppSecret} → 拿 wss URL + PingInterval 等
 *   2. new WebSocket(url)
 *   3. 收发 protobuf Frame（手写 proto.ts）：method 0=控制(ping/pong) 1=数据(event/card)
 *   4. 数据帧分片重组（message_id+sum+seq）→ JSON.parse → parseEvent → handleImMessage
 *   5. 处理后回 ACK Frame（echo + biz_rt header + payload {code:200}）
 *   6. 心跳 + liveness watchdog + generation-guarded 重连
 *
 * 长连接模式无需公网回调地址，SDK 封装鉴权（不用签名/加密）。
 */

import { getFeishuConfig } from './config.js';
import { parseEvent, isFeishuEvent } from './events.js';
import { handleImMessage } from '../bridge.js';
import { decodeFrame, encodeFrame, headersToRecord, type Frame, type Header } from './proto.js';

const FRAME_CONTROL = 0;
const FRAME_DATA = 1;
const PING_INTERVAL_DEFAULT = 30_000;
const RECONNECT_INTERVAL = 120_000;
const RECONNECT_NONCE = 30_000;
const LIVENESS_TIMEOUT = 180_000;

interface ClientConfig {
  pingInterval: number;
  reconnectCount: number;
  reconnectInterval: number;
  reconnectNonce: number;
}

interface Fragment {
  buffer: (Uint8Array | undefined)[];
  createdAt: number;
}

export class FeishuLongConnClient {
  private ws: WebSocket | null = null;
  private generation = 0;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private config: ClientConfig = {
    pingInterval: PING_INTERVAL_DEFAULT,
    reconnectCount: -1,
    reconnectInterval: RECONNECT_INTERVAL,
    reconnectNonce: RECONNECT_NONCE,
  };
  private fragments = new Map<string, Fragment>();
  private running = false;

  /** 启动长连接客户端。 */
  async start(): Promise<void> {
    this.running = true;
    await this.tryConnect(this.generation);
  }

  /** 停止客户端，关闭连接，清理定时器。 */
  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /** 拉取连接配置。 */
  private async pullConnectConfig(): Promise<{ url: string; config: ClientConfig }> {
    const cfg = getFeishuConfig();
    const res = await fetch(`${cfg.apiBase}/callback/ws/endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', locale: 'zh' },
      body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
    });
    const data = (await res.json()) as {
      code: number;
      msg?: string;
      data?: { URL: string; ClientConfig?: Record<string, number> };
    };
    if (data.code !== 0 || !data.data?.URL) {
      throw new Error(`拉取长连接配置失败: code=${data.code} ${data.msg ?? ''}`);
    }
    const cc = data.data.ClientConfig ?? {};
    return {
      url: data.data.URL,
      config: {
        pingInterval: (cc.PingInterval ?? 30) * 1000,
        reconnectCount: cc.ReconnectCount ?? -1,
        reconnectInterval: (cc.ReconnectInterval ?? 120) * 1000,
        reconnectNonce: (cc.ReconnectNonce ?? 30) * 1000,
      },
    };
  }

  /** 尝试拉配置 + 建连，失败则重连。 */
  private async tryConnect(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) return;
    let url: string;
    try {
      const result = await this.pullConnectConfig();
      this.config = result.config;
      url = result.url;
    } catch (e) {
      console.error('[feishu-lc] 拉取配置失败，重试', e);
      this.scheduleReconnect(gen);
      return;
    }
    if (!this.running || gen !== this.generation) return;
    this.openSocket(url, gen);
  }

  /** 打开 WebSocket。 */
  private openSocket(url: string, gen: number): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[feishu-lc] WebSocket 构造失败', e);
      this.scheduleReconnect(gen);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (gen !== this.generation) return;
      console.log('[feishu-lc] 长连接已建立');
      this.startPingLoop(gen);
    });

    ws.addEventListener('message', (event) => {
      this.clearLiveness();
      if (gen !== this.generation) return;
      void this.handleMessage(event, gen).catch((e) => {
        console.error('[feishu-lc] 消息处理失败', e);
      });
    });

    ws.addEventListener('close', () => {
      console.log('[feishu-lc] 连接关闭，准备重连');
      this.clearTimers();
      if (this.running && gen === this.generation) this.scheduleReconnect(gen);
    });

    ws.addEventListener('error', (e) => {
      console.error('[feishu-lc] WebSocket 错误', e);
    });

    // 建连 watchdog：open 超时则重连
    setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        console.warn('[feishu-lc] 建连超时，重连');
        try { ws.close(); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  /** 处理入站二进制消息。 */
  private async handleMessage(event: MessageEvent, gen: number): Promise<void> {
    let buf: Uint8Array;
    if (event.data instanceof ArrayBuffer) {
      buf = new Uint8Array(event.data);
    } else if (event.data instanceof Uint8Array) {
      buf = event.data;
    } else if (event.data instanceof Blob) {
      buf = new Uint8Array(await event.data.arrayBuffer());
    } else {
      return;
    }

    const frame = decodeFrame(buf);
    if (frame.method === FRAME_CONTROL) {
      this.handleControlData(frame);
    } else if (frame.method === FRAME_DATA) {
      await this.handleEventData(frame, gen);
    }
  }

  /** 控制帧：pong 携带更新后的配置。 */
  private handleControlData(frame: Frame): void {
    const hdr = headersToRecord(frame.headers);
    if (hdr.type === 'pong' && frame.payload) {
      try {
        const cfg = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, number>;
        if (cfg.PingInterval) this.config.pingInterval = cfg.PingInterval * 1000;
        if (cfg.ReconnectInterval) this.config.reconnectInterval = cfg.ReconnectInterval * 1000;
      } catch { /* ignore */ }
    }
  }

  /** 数据帧：分片重组 → parseEvent → handleImMessage → ACK。 */
  private async handleEventData(frame: Frame, gen: number): Promise<void> {
    const hdr = headersToRecord(frame.headers);
    const startTime = Date.now();

    // 只处理 event 类型（card 类型暂略）
    if (hdr.type !== 'event') {
      this.sendAck(frame, startTime, 200);
      return;
    }

    const messageId = hdr.message_id ?? '';
    const sum = Number(hdr.sum ?? '1');
    const seq = Number(hdr.seq ?? '0');

    let payload: string | null = null;

    if (sum <= 1) {
      payload = frame.payload ? new TextDecoder().decode(frame.payload) : null;
    } else {
      // 分片重组
      if (!this.fragments.has(messageId)) {
        this.fragments.set(messageId, { buffer: new Array(sum).fill(undefined), createdAt: Date.now() });
      }
      const frag = this.fragments.get(messageId)!;
      frag.buffer[seq] = frame.payload;
      if (frag.buffer.every((b) => b !== undefined)) {
        const merged = new Uint8Array(frag.buffer.reduce((acc, b) => acc + b!.length, 0));
        let offset = 0;
        for (const b of frag.buffer) { merged.set(b!, offset); offset += b!.length; }
        this.fragments.delete(messageId);
        payload = new TextDecoder().decode(merged);
      }
    }

    if (payload) {
      try {
        const parsed = parseEvent(payload);
        if (isFeishuEvent(parsed) && parsed.text) {
          handleImMessage('feishu', parsed.chatId, parsed.openId, parsed.messageId, parsed.text);
        }
      } catch (e) {
        console.error('[feishu-lc] 事件处理失败', e);
      }
    }

    this.sendAck(frame, startTime, 200);
  }

  /** 回发 ACK 帧。 */
  private sendAck(frame: Frame, startTime: number, code: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const bizRt = String(Date.now() - startTime);
    const ackPayload = new TextEncoder().encode(JSON.stringify({ code }));
    const ackFrame: Frame = {
      seqId: frame.seqId,
      logId: frame.logId,
      service: frame.service,
      method: frame.method,
      headers: [...frame.headers, { key: 'biz_rt', value: bizRt } satisfies Header],
      payload: ackPayload,
    };
    try {
      this.ws.send(encodeFrame(ackFrame));
    } catch (e) {
      console.error('[feishu-lc] 发送 ACK 失败', e);
    }
  }

  /** 心跳循环。 */
  private startPingLoop(gen: number): void {
    this.clearTimers();
    const ping = () => {
      if (!this.running || gen !== this.generation) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const pingFrame: Frame = {
          seqId: 0,
          logId: 0,
          service: 0,
          method: FRAME_CONTROL,
          headers: [{ key: 'type', value: 'ping' }],
        };
        try {
          this.ws.send(encodeFrame(pingFrame));
        } catch (e) {
          console.error('[feishu-lc] 发送 ping 失败', e);
        }
        // liveness watchdog
        this.livenessTimer = setTimeout(() => {
          console.warn('[feishu-lc] liveness 超时，断连重连');
          try { this.ws?.close(); } catch { /* ignore */ }
        }, LIVENESS_TIMEOUT);
      }
      this.pingTimer = setTimeout(ping, this.config.pingInterval);
    };
    ping();
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || gen !== this.generation) return;
    const delay = this.config.reconnectNonce * Math.random();
    console.log(`[feishu-lc] ${Math.round(delay)}ms 后重连`);
    setTimeout(() => {
      void this.tryConnect(gen);
    }, delay);
  }

  private clearLiveness(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = null; }
    this.clearLiveness();
  }
}

/** 进程级单例，由 index.ts 启动/停止。 */
let client: FeishuLongConnClient | null = null;

export function startFeishuLongConn(): void {
  const cfg = getFeishuConfig();
  if (!cfg.appId || !cfg.appSecret) {
    console.log('[feishu-lc] 飞书未配置，跳过长连接');
    return;
  }
  if (client) return;
  client = new FeishuLongConnClient();
  void client.start().catch((e) => console.error('[feishu-lc] 启动失败', e));
  console.log('[feishu-lc] 长连接客户端已启动');
}

export function stopFeishuLongConn(): void {
  client?.stop();
  client = null;
}

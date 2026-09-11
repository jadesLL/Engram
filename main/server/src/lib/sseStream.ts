/**
 * 解析 text/event-stream 字节流（event: x / data: {...} 帧）。
 * 单帧解析或回调失败忽略不中断整条流（与同步客户端既有语义一致）。
 * data 非 JSON 时以原始字符串回调。
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: any) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = frame.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.slice(7) : 'message';
      const raw = dataLine.slice(6);
      let data: any = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* 非 JSON 帧按原始字符串透传 */
      }
      try {
        onEvent(event, data);
      } catch {
        /* 单帧回调失败忽略 */
      }
    }
  }
}

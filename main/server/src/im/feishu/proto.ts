/**
 * 飞书长连接 protobuf Frame 手写编解码（零依赖）。
 * 仅实现飞书 ws-client 用到的两个字段集，不引入 protobufjs。
 *
 * Frame:  field1 SeqID(varint) field2 LogID(varint) field3 service(varint)
 *         field4 method(varint: 0=控制 1=数据) field5 headers(repeated Header)
 *         field6 payloadEncoding(string) field7 payloadType(string)
 *         field8 payload(bytes) field9 LogIDNew(string)
 * Header: field1 key(string) field2 value(string)
 *
 * wire types: 0=varint, 2=length-delimited
 */

export interface Header {
  key: string;
  value: string;
}

export interface Frame {
  seqId: number;
  logId: number;
  service: number;
  method: number;
  headers: Header[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  logIdNew?: string;
}

// ---- varint ----

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const byte = buf[p]!;
    p++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  }
  return [result >>> 0, p];
}

function writeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

// ---- length-delimited helpers ----

function readString(buf: Uint8Array, pos: number): [str: string, next: number] {
  const [len, afterLen] = readVarint(buf, pos);
  const bytes = buf.subarray(afterLen, afterLen + len);
  return [new TextDecoder().decode(bytes), afterLen + len];
}

function readBytes(buf: Uint8Array, pos: number): [data: Uint8Array, next: number] {
  const [len, afterLen] = readVarint(buf, pos);
  return [buf.subarray(afterLen, afterLen + len), afterLen + len];
}

function writeString(str: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(str));
  return [...writeVarint(bytes.length), ...bytes];
}

function writeBytes(data: Uint8Array): number[] {
  return [...writeVarint(data.length), ...Array.from(data)];
}

// ---- Header ----

function decodeHeader(buf: Uint8Array, end: number): Header {
  const header: Header = { key: '', value: '' };
  let pos = 0;
  while (pos < end) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = tag >>> 3;
    if (field === 1) {
      const [v, next] = readString(buf, pos);
      header.key = v;
      pos = next;
    } else if (field === 2) {
      const [v, next] = readString(buf, pos);
      header.value = v;
      pos = next;
    } else {
      pos = skipField(buf, pos, tag & 0x7);
    }
  }
  return header;
}

function encodeHeader(header: Header): number[] {
  const out: number[] = [];
  if (header.key) {
    out.push((1 << 3) | 2);
    out.push(...writeString(header.key));
  }
  if (header.value) {
    out.push((2 << 3) | 2);
    out.push(...writeString(header.value));
  }
  return out;
}

// ---- Frame ----

export function decodeFrame(buf: Uint8Array): Frame {
  const frame: Frame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [] };
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = tag >>> 3;
    const wireType = tag & 0x7;
    switch (field) {
      case 1:
        [frame.seqId, pos] = readVarint(buf, pos);
        break;
      case 2:
        [frame.logId, pos] = readVarint(buf, pos);
        break;
      case 3:
        [frame.service, pos] = readVarint(buf, pos);
        break;
      case 4:
        [frame.method, pos] = readVarint(buf, pos);
        break;
      case 5: {
        const [sub, next] = readBytes(buf, pos);
        frame.headers.push(decodeHeader(sub, sub.length));
        pos = next;
        break;
      }
      case 6:
        [frame.payloadEncoding, pos] = readString(buf, pos);
        break;
      case 7:
        [frame.payloadType, pos] = readString(buf, pos);
        break;
      case 8:
        [frame.payload, pos] = readBytes(buf, pos);
        break;
      case 9:
        [frame.logIdNew, pos] = readString(buf, pos);
        break;
      default:
        pos = skipField(buf, pos, wireType);
    }
  }
  return frame;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  out.push((1 << 3) | 0);
  out.push(...writeVarint(frame.seqId));
  out.push((2 << 3) | 0);
  out.push(...writeVarint(frame.logId));
  out.push((3 << 3) | 0);
  out.push(...writeVarint(frame.service));
  out.push((4 << 3) | 0);
  out.push(...writeVarint(frame.method));
  for (const header of frame.headers) {
    out.push((5 << 3) | 2);
    out.push(...writeBytes(new Uint8Array(encodeHeader(header))));
  }
  if (frame.payloadEncoding) {
    out.push((6 << 3) | 2);
    out.push(...writeString(frame.payloadEncoding));
  }
  if (frame.payloadType) {
    out.push((7 << 3) | 2);
    out.push(...writeString(frame.payloadType));
  }
  if (frame.payload) {
    out.push((8 << 3) | 2);
    out.push(...writeBytes(frame.payload));
  }
  if (frame.logIdNew) {
    out.push((9 << 3) | 2);
    out.push(...writeString(frame.logIdNew));
  }
  return new Uint8Array(out);
}

// ---- utils ----

function skipField(buf: Uint8Array, pos: number, wireType: number): number {
  if (wireType === 0) {
    const [, next] = readVarint(buf, pos);
    return next;
  }
  if (wireType === 2) {
    const [len, afterLen] = readVarint(buf, pos);
    return afterLen + len;
  }
  if (wireType === 5) return pos + 4;
  if (wireType === 1) return pos + 8;
  throw new Error(`unsupported wire type ${wireType}`);
}

/** headers 数组 → key→value record（便于读 type/message_id/sum/seq）。 */
export function headersToRecord(headers: Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.key] = h.value;
  return out;
}

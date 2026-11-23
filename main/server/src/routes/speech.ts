import type { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { wavAudioLevel } from '../lib/localSpeech.js';
import {
  SPEECH_MAX_AUDIO_BYTES,
  SPEECH_MAX_DURATION_SEC,
  SpeechUnavailableError,
  isWavBuffer,
  speechStatus,
  transcribeAudio,
  wavDurationSec,
} from '../lib/speechInput.js';

/**
 * 编辑器「语音输入」：状态 + 转写。
 *
 * 鉴权用 requireAssistantAccess（owner 登录态 / Agent 令牌 / 同步成员令牌都行）：
 * 手机没有模型，录音经本机 Ktor 窄代理打到中枢，转写在中枢那台设备上完成
 * （中枢是桌面端时可用本机离线识别；Docker 上则看客户配置的音频模型）。
 *
 * 录音只在本次请求里存在：不落盘、不进同步、不写日志；返回的只有转写文本。
 */
export async function speechRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  app.get('/api/speech/status', async () => speechStatus());

  app.post('/api/speech/transcribe', async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(415).send({ error: '请用 multipart/form-data 上传录音（字段名 audio）' });
    }
    let audio: Buffer | null = null;
    let engine = '';
    let oversized = false;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        // 用户在语音菜单里选的引擎（`local` / `model:<provider>:<model>`）；空 = 自动
        if (part.fieldname === 'engine') engine = String(part.value ?? '').trim();
        continue;
      }
      if (part.type !== 'file') continue;
      // 只认 audio（兼容旧字段名 file）；其余文件继续读掉但不使用
      const wanted = part.fieldname === 'audio' || part.fieldname === 'file';
      if (!wanted || audio) continue;
      const buffer = await part.toBuffer();
      if (buffer.length > SPEECH_MAX_AUDIO_BYTES) {
        oversized = true;
        continue;
      }
      audio = buffer;
    }
    if (oversized) {
      return reply
        .code(413)
        .send({ error: `录音太大了（上限 ${Math.round(SPEECH_MAX_AUDIO_BYTES / 1024 / 1024)}MB），请缩短后重试` });
    }
    if (!audio || !audio.length) return reply.code(400).send({ error: '没有收到录音' });
    if (!isWavBuffer(audio)) return reply.code(400).send({ error: '录音格式不对：只接受 WAV 16k 单声道' });
    const duration = wavDurationSec(audio);
    if (duration > SPEECH_MAX_DURATION_SEC) {
      return reply
        .code(400)
        .send({ error: `录音太长了（${Math.round(duration)} 秒，上限 ${SPEECH_MAX_DURATION_SEC} 秒），请分段录` });
    }

    // 只记体积/时长/音量档，不记音频内容；音量用来区分「麦克风没采到声音」和「识别不出来」
    const level = wavAudioLevel(audio);
    req.log.info(
      {
        bytes: audio.length,
        durationSec: Math.round(duration),
        levelPct: level ? Math.round(level.rms * 1000) / 10 : null,
        engine: engine || 'auto',
      },
      'speech transcribe'
    );
    try {
      const result = await transcribeAudio(audio, { engine });
      // 只记引擎与是否回退，不记转写内容：排查「为什么用了本机识别」时不用再猜
      req.log.info(
        { engine: result.engine, fallback: result.warning ? true : undefined },
        'speech transcribe done'
      );
      return result;
    } catch (error: any) {
      if (error instanceof SpeechUnavailableError) {
        return reply.code(409).send({ error: error.message });
      }
      req.log.warn({ err: error?.message }, 'speech transcribe failed');
      return reply.code(502).send({ error: error?.message || '语音识别失败' });
    }
  });
}

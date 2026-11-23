/**
 * SenseVoice 本地识别模型的身份信息（与随包 dsh 的
 * `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json` 保持一致）。
 *
 * 为什么不每次运行时去读 dsh 包里的 assets.json：模型是固定修订的发布物，大小与 SHA-256
 * 是安全边界；把身份信息放在 Engram 侧，dsh 升级/目录调整时不会让「本机识别」突然不可用。
 * 升级 dsh 时若模型修订变化，同步这里的三条记录即可。
 *
 * 缓存目录与 dsh 语音输入共用：`<数据目录>/dsh/speech-to-text/sensevoice/models/...`，
 * 用户在任一侧下载过一次，另一侧直接复用。
 */
export interface SenseVoiceAsset {
  /** 缓存目录里的文件名 */
  name: string;
  /** 固定修订的上游路径（下载时替换 origin） */
  url: string;
  bytes: number;
  sha256: string;
}

/** int8 是默认精度：约 239MB，CPU 推理足够；fp32 仅作记录，不下载 */
export const SENSEVOICE_MODEL_INT8: SenseVoiceAsset = {
  name: 'model.int8.onnx',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
  bytes: 239233841,
  sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
};

export const SENSEVOICE_TOKENS: SenseVoiceAsset = {
  name: 'tokens.txt',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
  bytes: 315894,
  sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
};

export const SENSEVOICE_VAD: SenseVoiceAsset = {
  name: 'silero_vad.onnx',
  url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  bytes: 1807522,
  sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
};

/** 按下载顺序排列；模型最大，放最前面，进度条先动起来 */
export const SENSEVOICE_ASSETS = [SENSEVOICE_MODEL_INT8, SENSEVOICE_TOKENS, SENSEVOICE_VAD];

export const SENSEVOICE_TOTAL_BYTES = SENSEVOICE_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);

/** 默认下载源：国内优先镜像，失败再回 HuggingFace */
export const SENSEVOICE_SOURCES = ['https://hf-mirror.com', 'https://huggingface.co'];

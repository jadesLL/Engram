#!/usr/bin/env bash
# CI 容器内执行：同步 web 资产 + gradle 构建 release APK
# 签名密钥经环境变量注入（见 Dockerfile.ci 头部说明）；未注入时产出未签名 APK
set -euo pipefail
cd /work/mobile

if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > /work/release.keystore
  export ANDROID_KEYSTORE_FILE=/work/release.keystore
  export ANDROID_KEYSTORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD 必填}"
  export ANDROID_KEY_ALIAS="${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS 必填}"
  export ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
  echo ">> 使用注入的 keystore 签名"
else
  echo ">> 未提供 ANDROID_KEYSTORE_BASE64，产出未签名 release APK"
fi

echo ">> cap sync android"
pnpm exec cap sync android

echo ">> gradlew assembleRelease"
cd android

# 镜像构建期已预热 gradle 缓存（Dockerfile.ci 末层，标记文件在 GRADLE_USER_HOME）：
# 优先 --offline 复用，彻底消除发版时的运行时网络依赖；离线失败回退在线构建（与旧行为一致）
GRADLE_CACHE="${GRADLE_USER_HOME:-$HOME/.gradle}"
GRADLE_ARGS=(assembleRelease --no-daemon)
if [ -f "$GRADLE_CACHE/.warm-ok" ]; then
  echo ">> 检测到镜像预热缓存，优先离线构建"
  GRADLE_ARGS+=(--offline)
fi

if ! ./gradlew "${GRADLE_ARGS[@]}"; then
  if [ -f "$GRADLE_CACHE/.warm-ok" ]; then
    echo ">> 离线构建失败，回退在线构建"
    ./gradlew assembleRelease --no-daemon
  else
    exit 1
  fi
fi

echo ">> 产物："
ls -la app/build/outputs/apk/release/

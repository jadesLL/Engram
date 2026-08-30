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
./gradlew assembleRelease --no-daemon

echo ">> 产物："
ls -la app/build/outputs/apk/release/

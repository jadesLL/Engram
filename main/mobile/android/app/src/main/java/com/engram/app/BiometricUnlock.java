package com.engram.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.hardware.fingerprint.FingerprintManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * 「用系统的方式解锁」：指纹 / 人脸 / 锁屏密码（设备凭据）都交给系统弹窗，应用自己不画解锁界面。
 *
 * 为什么要有它：手机版进入知识库要输密码（本地服务的会话 cookie 最多 30 天，过期或退出登录后
 * 会回到登录页）。用户要求这块支持指纹/人脸，并**调用系统能力**而不是自绘图案锁。
 *
 * 做法（不引入任何新依赖，全部走系统框架 API）：
 *  - Android 11+（API 30）：{@code BiometricPrompt} + {@code BIOMETRIC_WEAK | DEVICE_CREDENTIAL}，
 *    有指纹/人脸就走生物识别，没录生物识别就落到锁屏密码，弹窗形状由系统决定；
 *  - Android 9/10（API 28-29）：同一个 {@code BiometricPrompt}，用
 *    {@code setDeviceCredentialAllowed(true)}（该 API 在 30 起被 allowed authenticators 取代，
 *    但这两个版本上没有别的等价写法）；
 *  - Android 6-8（API 23-27）：{@code KeyguardManager.createConfirmDeviceCredentialIntent()}，
 *    由系统出示锁屏验证界面（这一档没有统一的生物识别弹窗，指纹 API 也已废弃）。
 *
 * 凭据本身仍然只有一份：登录密码。开启后它被 {@link SecretStore} 用 Android Keystore 的
 * AES-GCM 密钥密封存盘（密钥不可导出），**只有系统解锁成功之后**才会取出并交给网页去换会话
 * cookie；解锁失败/取消/没开启过，都不会有任何凭据离开本进程。
 *
 * 与网页的契约（{@code web/src/lib/biometric.ts}）：
 *  - {@code status()} → 能力与是否已记住密码；
 *  - {@code remember(password)} → 开启（网页在登录成功后调用）；
 *  - {@code unlock(requestId)} → 弹系统解锁；结果经
 *    {@code window.__engramBiometricResult(requestId, {"ok":true,"password":"…"})} 回给网页；
 *  - {@code forget()} → 关闭（网页在改密码或用户关掉开关时调用）。
 */
public class BiometricUnlock {

    /** 设备凭据（API 23-27 的钥匙串验证）用 startActivityForResult 打开，MainActivity 负责转发结果 */
    public static final int REQUEST_CREDENTIAL = 18183;

    private static final String SECRET_NAME = "unlock_password";
    private static final String BRIDGE_NAME = "EngramBiometric";

    private final Activity activity;
    private final WebView webView;
    private final SecretStore secrets;

    /** 正在弹系统解锁：同一时刻只允许一个，避免连点弹出两个弹窗 */
    private volatile boolean prompting = false;
    private volatile String pendingRequestId = null;

    public BiometricUnlock(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.secrets = new SecretStore(activity.getApplicationContext());
    }

    /** 装 JS 桥；必须在加载页面之前调用（与 SystemBars 同一个时机）。 */
    public void install() {
        webView.addJavascriptInterface(new Bridge(), BRIDGE_NAME);
    }

    // ---------------------------------------------------------------- 能力与凭据

    private boolean deviceSecure() {
        KeyguardManager keyguard = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    private boolean biometricEnrolled() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            BiometricManager manager = activity.getSystemService(BiometricManager.class);
            if (manager == null) return false;
            // API 30 起有 canAuthenticate(int)；这张表只看「有没有录入生物识别」
            int result = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                    : manager.canAuthenticate();
            return result == BiometricManager.BIOMETRIC_SUCCESS;
        }
        // API 28-29 没有 BiometricManager：用已废弃的指纹接口问硬件是否录入（仅用于判断能力）
        FingerprintManager fingerprint = (FingerprintManager) activity.getSystemService(Context.FINGERPRINT_SERVICE);
        return fingerprint != null && fingerprint.isHardwareDetected() && fingerprint.hasEnrolledFingerprints();
    }

    /** 能力档：biometric（指纹/人脸）/ credential（只有锁屏密码）/ none */
    private String capability() {
        if (biometricEnrolled()) return "biometric";
        if (deviceSecure()) return "credential";
        return "none";
    }

    private boolean supported() {
        return !"none".equals(capability()) || deviceSecure();
    }

    private String statusJson() {
        try {
            JSONObject json = new JSONObject();
            String capability = capability();
            // 能弹系统解锁就报可用；真正弹哪一档由系统按录入情况决定
            json.put("available", supported());
            json.put("kind", capability);
            json.put("saved", secrets.get(SECRET_NAME) != null);
            return json.toString();
        } catch (Exception error) {
            return "{\"available\":false,\"kind\":\"none\",\"saved\":false}";
        }
    }

    // ---------------------------------------------------------------- 系统解锁

    private void startUnlock(final String requestId) {
        if (prompting) {
            deliver(requestId, failure("busy"));
            return;
        }
        if (!supported()) {
            deliver(requestId, failure("unsupported"));
            return;
        }
        if (secrets.get(SECRET_NAME) == null) {
            deliver(requestId, failure("no-secret"));
            return;
        }
        prompting = true;
        pendingRequestId = requestId;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            activity.runOnUiThread(this::showBiometricPrompt);
            return;
        }
        activity.runOnUiThread(this::showDeviceCredentialIntent);
    }

    private void showBiometricPrompt() {
        try {
            // 框架版 BiometricPrompt 没有公开构造器：弹窗内容由 Builder 组装，
            // 校验用 authenticate()。这一档在 API 28+ 都可用，不需要 androidx.biometric。
            BiometricPrompt.Builder builder = new BiometricPrompt.Builder(activity)
                    .setTitle("解锁 Engram")
                    .setSubtitle("验证后直接进入知识库");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_WEAK
                                | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                // API 28-29：allowed authenticators 还不存在；deviceCredentialAllowed 与负按钮互斥，
                // 所以这一档不设「取消」按钮（返回键/点空白仍可取消）
                builder.setDeviceCredentialAllowed(true);
            }
            BiometricPrompt prompt = builder.build();
            // 回调走主线程 Executor（API 28+ 的 getMainExecutor）：BiometricPrompt 只要 Executor，
            // 不是 Handler
            prompt.authenticate(new CancellationSignal(), activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    deliverSecret();
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    // 用户取消（含返回键/点空白）与系统失败走同一出口：网页只关心「没解锁成功」
                    deliver(pendingRequestId, failure(errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED
                            ? "canceled"
                            : "failed"));
                }
            });
        } catch (Throwable error) {
            // 厂商 ROM 上 BiometricPrompt 偶发不可用：退回系统凭据验证，不让用户卡在登录页
            showDeviceCredentialIntent();
        }
    }

    private void showDeviceCredentialIntent() {
        KeyguardManager keyguard = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
        Intent intent = keyguard == null ? null
                : keyguard.createConfirmDeviceCredentialIntent("解锁 Engram", "验证后直接进入知识库");
        if (intent == null) {
            deliver(pendingRequestId, failure(supported() ? "failed" : "unsupported"));
            return;
        }
        try {
            activity.startActivityForResult(intent, REQUEST_CREDENTIAL);
        } catch (Throwable error) {
            deliver(pendingRequestId, failure("failed"));
        }
    }

    /** MainActivity 把 onActivityResult 转进来；只认自己的 REQUEST_CREDENTIAL。 */
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CREDENTIAL) return false;
        if (resultCode == Activity.RESULT_OK) deliverSecret();
        else deliver(pendingRequestId, failure("canceled"));
        return true;
    }

    private void deliverSecret() {
        String password = secrets.get(SECRET_NAME);
        if (password == null || password.isEmpty()) {
            deliver(pendingRequestId, failure("no-secret"));
            return;
        }
        try {
            JSONObject json = new JSONObject();
            json.put("ok", true);
            json.put("password", password);
            deliver(pendingRequestId, json.toString());
        } catch (Exception error) {
            deliver(pendingRequestId, failure("failed"));
        }
    }

    private String failure(String reason) {
        try {
            JSONObject json = new JSONObject();
            json.put("ok", false);
            json.put("reason", reason);
            return json.toString();
        } catch (Exception error) {
            return "{\"ok\":false,\"reason\":\"failed\"}";
        }
    }

    /** 把结果回给网页；无论成功失败都要清掉「正在弹窗」标志，否则后面再也弹不出来。 */
    private void deliver(String requestId, String payload) {
        prompting = false;
        pendingRequestId = null;
        if (requestId == null) return;
        final String script = "window.__engramBiometricResult&&window.__engramBiometricResult("
                + JSONObject.quote(requestId) + "," + payload + ")";
        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (Throwable ignored) {
                // 页面已经跳走时 evaluateJavascript 会抛错，忽略即可
            }
        });
    }

    /** 暴露给网页的桥（方法在 JavaBridge 线程被调用，涉及弹窗的一律转主线程）。 */
    public class Bridge {

        @JavascriptInterface
        public String status() {
            return statusJson();
        }

        @JavascriptInterface
        public String remember(String password) {
            if (password == null || password.isEmpty()) return "{\"ok\":false}";
            secrets.put(SECRET_NAME, password);
            return "{\"ok\":true}";
        }

        @JavascriptInterface
        public void forget() {
            secrets.put(SECRET_NAME, null);
        }

        @JavascriptInterface
        public void unlock(String requestId) {
            startUnlock(requestId == null || requestId.isEmpty() ? "default" : requestId);
        }

        /** 系统「设置 → 安全」入口：没有可用解锁方式时，网页给用户一个去录入的台阶 */
        @JavascriptInterface
        public void openSecuritySettings() {
            activity.runOnUiThread(() -> {
                try {
                    activity.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
                } catch (Throwable ignored) {
                    // 个别 ROM 没有这个入口，忽略
                }
            });
        }
    }
}

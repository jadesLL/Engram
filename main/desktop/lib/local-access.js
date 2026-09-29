// 「局域网访问」开关与内嵌服务的监听地址：纯函数，供主进程与单测共用。
//
// 桌面版默认只监听 127.0.0.1——这是个装在个人电脑上的应用，没必要让整个局域网都能打开它。
// 但要拿这台电脑当同步中枢，别的设备必须连得到：只监听回环时服务端算不出一条能交给成员的
// 地址（旧版界面会把 http://127.0.0.1:18180 抄给用户，手机填了永远连不上），因此设置页给了
// 这个开关——打开后内嵌服务以 0.0.0.0 重启（窗口自动重载，本机仍可用 127.0.0.1 打开）。
const LOOPBACK_HOST = '127.0.0.1';
const LAN_HOST = '0.0.0.0';

/** config.json 里的 lanAccess：只认严格 true，坏值与缺省都按关闭处理 */
function lanAccessEnabled(config) {
  return Boolean(config) && config.lanAccess === true;
}

/** 内嵌服务的监听地址：开了局域网访问就 0.0.0.0，否则回环专用 */
function localHost(config) {
  return lanAccessEnabled(config) ? LAN_HOST : LOOPBACK_HOST;
}

module.exports = { lanAccessEnabled, localHost, LOOPBACK_HOST, LAN_HOST };

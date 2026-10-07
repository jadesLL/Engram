function joinLinkFromArgs(args) {
  return args.find((arg) => typeof arg === 'string' && arg.length <= 2048 && /^engram:\/\/join\?/i.test(arg)) || '';
}
function protocolRegistration(execPath, appPath, defaultApp) {
  return defaultApp ? ['engram', execPath, [appPath]] : ['engram'];
}
module.exports = { joinLinkFromArgs, protocolRegistration };

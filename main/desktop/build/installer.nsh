; 让 NSIS 安装器显示详情框 + 阶段日志，替代 electron-builder 默认的"只有进度条看不到内容"。
; 覆盖 common.nsh 的 ShowInstDetails nevershow + installSection.nsh 的 SetDetailsPrint none。
; customHeader 在 common.nsh include 之后（installer.nsi:46），可覆盖 ShowInstDetails；
; customInstall 在 installSection.nsh:81（SetDetailsPrint none 之后、解压之后），设 SetDetailsPrint both 让后续 DetailPrint 可见。

!macro customHeader
  ShowInstDetails show
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "──────────────────────────────────────"
  DetailPrint "${PRODUCT_NAME} ${VERSION}  文件已就位"
  DetailPrint "安装目录：$INSTDIR"
  DetailPrint "──────────────────────────────────────"
!macroend

!macro customUnInstall
  SetDetailsPrint both
  DetailPrint "正在卸载 ${PRODUCT_NAME}..."
!macroend

; ── 安装作用域：固定「仅当前用户」，使应用内自动更新全程不需要提权 ──
; 自动更新以 `/S` 静默运行安装包；只要安装目录在 Program Files（当初选了「为所有用户安装」），
; 每次静默升级都会走 installer.nsi 的 Silent 分支 UAC_RunElevated，弹一次 UAC。
; Windows 不允许静默越过 UAC，所以从安装器层面取消「为所有用户安装」：
;   · customInstallMode：跳过安装模式选择页，强制当前用户（%LOCALAPPDATA%\Programs\Engram）；
;   · customInit：检测到旧版 Program Files 安装时先引导卸载，避免出现两份 Engram。
; 对应 desktop/package.json 的 nsis.perMachine=false + allowElevation=false，由 installer-scope.test.js 锁住。
!ifndef BUILD_UNINSTALLER
  !macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
  !macroend
!endif

!macro customInit
  ${if} $hasPerMachineInstallation == "1"
    ; 静默安装（应用内自动更新）不拦：旧的所有用户安装仍可正常升级到本版
    IfSilent engr_skip_per_machine_guard
    MessageBox MB_ICONINFORMATION|MB_OK "检测到本机已安装「为所有用户安装」的旧版 Engram：$\r$\n$perMachineInstallationFolder$\r$\n$\r$\n新版固定为「仅当前用户」安装。请先在 Windows「设置 → 应用 → 已安装的应用」中卸载旧版，再运行本安装包，否则会出现两份 Engram。"
    Quit
    engr_skip_per_machine_guard:
  ${endif}
!macroend

; ── 覆盖升级兜底（2026-11-08）────────────────────────────────────────────────
; 用户实例：装了 1.5.7 的机器覆盖安装 1.5.8 时报
;   "Failed to uninstall old application files. Please try running the installer again.: 2"
; 机制：electron-builder 的升级路径先跑旧版卸载器（--updated 把旧安装目录逐个文件改名到临时
; 目录），旧卸载器返回非 0 时 handleUninstallResult 直接 SetErrorLevel 2 + Quit，升级中止。
; 旧卸载器失败的现实原因：旧安装目录里还有残留进程占着文件（内置 Agent 的 node.exe 孙进程、
; 杀软扫描、跨盘改名），只要一个文件改名失败就 Abort。
; 兜底：失败也继续装，先清空旧目录再覆盖。代价是这一次升级失去「失败可回滚」，可以接受——
; 用户数据与设置在 userData，不在安装目录，清安装目录不影响数据。
!macro customUnInstallCheck
  ${if} $R0 == 0
    Return
  ${endif}
  DetailPrint "旧版本卸载失败（Exit code $R0），改为清理旧安装目录后继续覆盖安装：$INSTDIR"
  RMDir /r "$INSTDIR"
!macroend

!macro customUnInstallCheckCurrentUser
  ${if} $R0 == 0
    Return
  ${endif}
  DetailPrint "旧版本卸载失败（Exit code $R0），改为清理旧安装目录后继续覆盖安装：$INSTDIR"
  RMDir /r "$INSTDIR"
!macroend

; 新装出来的卸载器自己也不再因为个别文件被占用而整次 Abort：默认实现（--updated）是逐文件
; 改名到临时目录，一个占用就 Abort，于是下一次升级又卡在同一个报错上。这里改为「尽量删除」：
; 删不掉的文件留着无妨，注册表与快捷方式照常清理。
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
!macroend

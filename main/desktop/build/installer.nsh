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

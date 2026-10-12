; Corum 安装器 UI 微调（electron-builder `nsis.include` 注入，见
; packages/desktop/package.json 的 build.nsis.include）。
;
; 生效点（electron-builder 25.1.8 模板实测）：
; - `customInit` → 注入 installer.nsi 的 `.onInit`，安装器启动即执行；
; - `customInstall` → 注入安装 Section 尾（文件释放完成后）。
;
; 1. 默认展开详情窗格：看释放进度不需要再点「显示详细信息」。
; 2. 收尾打印完成行：详情窗格里留一条完成信号。
;
; 做不到的事（模板限制，如实记录，勿试图用钩子绕）：
; 文件级 `Extract: ...` 明细被 installSection.nsh 的 `SetDetailsPrint none`
; 硬压住，且模板没有中段钩子（customInit 太早会被覆盖，customInstall 太晚）。
; 逐文件列表对 1.5 万文件本就是刷屏，真正的解法是减文件数
; （pack-macos.mjs pruneClosureDeadWeight）而不是看列表。

!macro customInit
  ShowInstDetails show
!macroend

!macro customInstall
  DetailPrint "Corum 安装完成：应用文件已释放到 $INSTDIR"
!macroend

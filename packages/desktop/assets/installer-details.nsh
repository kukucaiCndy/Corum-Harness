; Corum 安装器 UI 微调 + Windows Defender 排除（electron-builder `nsis.include` 注入）。
;
; 生效点（electron-builder 25.1.8 模板实测）：
; - `customInstall` → 注入安装 Section 尾（文件释放完成后）。
;
; 1. Windows Defender 排除安装目录（减少启动时杀软扫描 .js 文件的开销，
;    这是 Windows 上 corum 启动慢 47s 的主要因素之一）。
;    用 PowerShell 的 Add-MpPreference（需要管理员权限；perUser 安装时
;    可能失败，静默跳过——非阻断）。
; 2. 收尾打印完成行。

!macro customInstall
  ; Windows Defender 排除（best-effort，失败不阻断安装）
  nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -Command "try { Add-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue } catch {}"'
  DetailPrint "Corum 安装完成：应用文件已释放到 $INSTDIR"
!macroend

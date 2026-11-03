; The NSIS installer's hooks (tauri.conf.json bundle.windows.nsis.installerHooks).

; "Open with C-Bot" in Explorer's right-click menu (ui/folder_menu.rs adds it on start):
; gone with C-Bot. (An update's uninstall takes it too; the new C-Bot adds it back.)
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\C-Bot"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\C-Bot"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\Glassnote Capture.lnk" "$INSTDIR\glassnote.exe" "--capture" "$INSTDIR\glassnote.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\Glassnote Capture.lnk"
!macroend

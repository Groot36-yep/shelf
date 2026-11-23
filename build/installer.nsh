; Shelf's additions to electron-builder's Windows installer (picked up from build/installer.nsh).
;
; Keep your shortcuts and taskbar pin when you install a newer Shelf over an older one.
;
; Because the installer lets you choose Shelf's folder ("allowToChangeInstallationDirectory"),
; electron-builder treats every update you run yourself as a brand-new install: it uninstalls the old
; Shelf *with* its shortcuts (which unpins it from the taskbar) and makes new ones. The setting is only
; used twice: to show the "choose a folder" page, and to make that decision. The page is already in
; place by the time this runs, so switching the setting off here keeps the folder choice and keeps your
; shortcuts. If you choose a different folder, the old shortcuts would point nowhere, so the installer
; still makes fresh ones (it keeps them only when Shelf.exe is already in the folder you install to).
!macro customHeader
  !ifdef allowToChangeInstallationDirectory
    !undef allowToChangeInstallationDirectory
  !endif
!macroend

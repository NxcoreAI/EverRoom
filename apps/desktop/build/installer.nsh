; 内置 lark-cli 的卸载清理（与桌面应用同生命周期）。
;
; 可执行文件本身随安装目录（resources\lark-cli\...）一起删除；这里只清理安装包
; 之外、由 lark-cli 在“应用私有 HOME”下写出的配置/凭据回退文件：
;   桌面主进程把 lark-cli 子进程的 HOME/USERPROFILE/APPDATA/LOCALAPPDATA
;   重定向到 <userData>\lark-cli\home（userData = %APPDATA%\EverRoom），
;   因此卸载时删除这段私有目录即可，不触碰用户终端里自己的 ~/.lark-cli。
;
; 不需要结束 lark-cli 进程：安装器要求应用已退出，而应用退出时授权控制器会
; 结束自己启动的全部 lark-cli 子进程（LarkAuthRunner.shutdown）。
;
; 注意：系统凭据管理器里的条目不属于文件系统，卸载器不能安全枚举；注销飞书
; （连接器页「注销」→ lark-cli auth logout）会清理凭据，详见
; docs/lark-cli-bundling.zh-CN.md。
!macro customUnInstall
  RMDir /r "$APPDATA\EverRoom\lark-cli"
  RMDir /r "$LOCALAPPDATA\EverRoom\lark-cli"
!macroend
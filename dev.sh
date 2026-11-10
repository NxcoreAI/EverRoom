#!/bin/bash
# EverOffice dev 免疫启动器:整棵进程树脱离终端会话,GUI 终端(VS Code/Claude 面板)
# 对前台进程组的挂起信号(SIGTSTP)永远够不到它。macOS 无 setsid,用 python os.setsid。
# 用法:任意终端里 ./dev.sh  (关掉该终端窗口也不影响)
cd "$(dirname "$0")"
LOG=/tmp/everoffice-dev.log
python3 -c "
import os, subprocess, sys
with open('$LOG','ab') as log, open(os.devnull,'rb') as dn:
    p = subprocess.Popen(['pnpm','dev'], stdout=log, stderr=log, stdin=dn,
                         cwd=os.getcwd(), start_new_session=True)
    print(p.pid)
" | { read pid; echo "已脱离终端启动 pid=$pid,日志: $LOG"; }
echo "停止: pkill -f 'scripts/dev.mjs'; pkill -f 'Desktop/EverOffice.*electron'"

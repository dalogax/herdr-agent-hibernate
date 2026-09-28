# Records demo/demo.gif. See demo/README.md.
Output demo/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 680
Set Padding 12
Set TypingSpeed 0
Set Framerate 10
Set Theme "Catppuccin Mocha"

Env HIBERNATE_IDLE_MINUTES "0.2"
Env HIBERNATE_POLL_SECONDS "2"

Hide
Type "export SHELL=$PWD/demo/shell.sh; (demo/setup.sh > /dev/null 2>&1 &); herdr --session hibdemo"
Enter
Sleep 2s
Show

Sleep 50s

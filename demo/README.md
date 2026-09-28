# Demo recording

`demo.gif` is recorded with [VHS](https://github.com/charmbracelet/vhs):

```sh
mkdir -p /tmp/my-app
herdr plugin link "$PWD"           # the plugin under test
# If opencode is a version-manager shim, point at the real binary's dir:
export DEMO_AGENT_PATH="$(dirname "$(mise which opencode)")"
env -i HOME="$HOME" PATH="$PATH" TERM=xterm-256color DEMO_AGENT_PATH="$DEMO_AGENT_PATH" \
  vhs demo/demo.tape
./demo/optimize.sh                  # shrink the GIF
herdr session stop hibdemo && herdr session delete hibdemo
```

The tape starts a throwaway `hibdemo` Herdr session with a 12-second idle
window. `setup.sh` builds the layout, starts OpenCode, sends one prompt, then
moves focus away and back, talking only to the `hibdemo` socket. Requires
`opencode` with the Herdr OpenCode integration, and `jq`.

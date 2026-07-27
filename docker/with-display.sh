#!/bin/sh
# Ensure there is an X display, then run whatever was asked for.
#
# `xvfb-run` fails silently in this image — no output, no exit, nothing to
# diagnose — so the display is started directly and waited for. Being the
# entrypoint means every command gets one without having to remember a wrapper,
# and the API container is unaffected because it never opens a window.
set -e

if [ -z "$DISPLAY" ]; then
  Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  export DISPLAY=:99

  # Wait for the socket rather than sleeping a guessed amount: Chrome launched
  # against a display that is not up yet hangs instead of failing.
  i=0
  while [ ! -e /tmp/.X11-unix/X99 ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
      echo "Xvfb did not start within 10s; see /tmp/xvfb.log" >&2
      cat /tmp/xvfb.log >&2 || true
      exit 1
    fi
    sleep 0.1
  done
fi

exec "$@"

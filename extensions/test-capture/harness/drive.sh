#!/bin/sh
# Resilient routing driver. Reads "expect|prompt" lines on stdin; runs ONE
# route1.mjs (one harness scenario) per line. A node child crash prints an
# error line but never kills this loop, because the shell parent is immune to
# the child's uncaught exceptions. Arg1 = bot/profile name.
bot="$1"
cd "$(dirname "$0")" || exit 1
while IFS='|' read -r exp prompt; do
  [ -z "$exp" ] && continue
  # </dev/null so route1.mjs cannot consume the heredoc lines this while-loop
  # is reading from stdin (classic read-loop stdin-steal bug).
  res=$(node route1.mjs "$bot" "$prompt" </dev/null 2>/dev/null)
  echo "$exp :: $res"
  # Reap lingering detached `dist/entry.js agent` reset boots between prompts.
  # harness.mjs spawns one per scenario, detached, and they "hang on teardown";
  # left to pile up they OOM the 4GB cgroup and the kernel kills PID 1 (the
  # gateway), restarting the container. Reap + settle keeps peak at one boot.
  pkill -f "dist/entry.js agent" 2>/dev/null
  sleep 3
done

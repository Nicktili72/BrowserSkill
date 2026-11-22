#!/bin/bash
# Adds safari.md to every installed `browser-skill` (all harnesses that have it)
# and points SKILL.md at it. Idempotent; re-run after `bsk install-skill --force`.
set -euo pipefail
cd "$(dirname "$0")"
for dir in "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.claude-internal/skills" "$HOME/.codex-internal/skills" \
           "$HOME/.cursor/skills" "$HOME/.openclaw/skills" "$HOME/.openclaw-internal/skills" "$HOME/.codebuddy/skills" \
           "$HOME/.workbuddy/skills" "$HOME/.pi/agent/skills" "$HOME/.hermes/skills" "$HOME/.kimi-code/skills"; do
  skill="$dir/browser-skill"
  [ -f "$skill/SKILL.md" ] || continue
  mkdir -p "$skill/references"
  cp safari.md "$skill/references/safari.md"
  python3 - "$skill/SKILL.md" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if 'references/safari.md' in s:
    sys.exit(0)
bullet = "- If `bsk browsers` shows **Safari**, read [Safari notes](references/safari.md) first: several commands are unsupported and pages need site access granted.\n"
marker = "## Before acting\n\n"
assert marker in s, "unexpected SKILL.md layout"
s = s.replace(marker, marker + bullet, 1)
row = "| Browser is Safari (`bsk browsers`), or a command returns `unsupported`, or pages don't respond | [Safari notes](references/safari.md) |\n"
tbl = "| --- | --- |\n"
assert tbl in s, "unexpected SKILL.md table"
s = s.replace(tbl, tbl + row, 1)
open(p, 'w').write(s)
PY
  echo "updated $skill"
done

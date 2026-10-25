#!/usr/bin/env sh
# AI-assisted code review as a repeatable, local step.
#
#   scripts/ai-review.sh [--base <ref>] [--working-tree]
#
# Reviews `git diff <base>...HEAD` (or, with --working-tree, every tracked
# change not yet committed, staged or not; untracked files are not included) with the brief in scripts/ai-review-prompt.md, writes the
# review to reports/ai-review/<sha>-<reviewer>.md and exits 1 on
# `VERDICT: REQUEST_CHANGES` (2 when the reviewer fails or the verdict is
# malformed), so the same command works as a pre-push gate, a CI step, or a
# one-off second opinion. The AI is a reviewer, not an approver:
# a human still merges, and a REQUEST_CHANGES is a conversation, not a verdict.
set -eu

BASE="origin/main"
REVIEWER="claude"
# Only Claude: `codex exec --sandbox read-only` still starts configured MCP
# servers, whose startup can write, so it does not meet the read-only guarantee.
WORKING_TREE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --working-tree) WORKING_TREE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
BRIEF="$ROOT/scripts/ai-review-prompt.md"
SHA="$(git rev-parse --short HEAD)"
OUT_DIR="$ROOT/reports/ai-review"
OUT="$OUT_DIR/$SHA-$REVIEWER.md"
mkdir -p "$OUT_DIR"

# Lockfiles, snapshots and images are reviewed by their tools, not by a reader.
PATHSPEC=". :(exclude)package-lock.json :(exclude)**/__snapshots__/** :(exclude)**/*.png :(exclude)**/*.snap"
if [ "$WORKING_TREE" -eq 1 ]; then
  # shellcheck disable=SC2086
  DIFF="$(git diff --no-color HEAD -- $PATHSPEC)"
  SCOPE="working tree vs HEAD ($SHA)"
else
  # shellcheck disable=SC2086
  DIFF="$(git diff --no-color "$BASE...HEAD" -- $PATHSPEC)"
  SCOPE="$BASE...HEAD ($SHA)"
fi
if [ -z "$DIFF" ]; then
  echo "ai-review: nothing to review in $SCOPE" >&2
  exit 0
fi

# Keep the request bounded: a 300 KB diff is a signal to split the PR, not a
# reason to truncate silently.
SIZE="$(printf '%s' "$DIFF" | wc -c | tr -d ' ')"
if [ "$SIZE" -gt 300000 ]; then
  echo "ai-review: diff is $SIZE bytes; split the change before review" >&2
  exit 2
fi

INPUT="$(cat "$BRIEF"; printf '\n\nScope: %s\n\n<diff>\n%s\n</diff>\n' "$SCOPE" "$DIFF")"

reviewer_failed() {
  echo "ai-review: $REVIEWER exited with an error; see $OUT" >&2
  exit 2
}

case "$REVIEWER" in
  claude)
    # Read-only by construction, not by instruction: only the three read tools
    # exist (--tools), write tools are denied even if re-added, no settings
    # sources are loaded (so no inherited hooks run) and no MCP server is
    # attached (--strict-mcp-config with no --mcp-config).
    printf '%s' "$INPUT" | claude -p --output-format text \
      --setting-sources '' --strict-mcp-config \
      --tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" \
      --disallowedTools "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch" \
      > "$OUT" ||
      reviewer_failed
    ;;
  *)
    echo "unknown reviewer: $REVIEWER (only claude is isolated well enough; see docs/33 §7)" >&2
    exit 2
    ;;
esac

echo "ai-review: $OUT"
# The verdict must be the last non-empty line and must occur exactly once;
# anything else is a malformed review (exit 2), never an approval. The brief
# itself is not in the output, so its format line cannot match here.
LAST="$(grep -v '^[[:space:]]*$' "$OUT" | tail -n 1)"
COUNT="$(grep -c -E '^[[:space:]]*VERDICT:[[:space:]]' "$OUT" || true)"
if [ "$COUNT" -ne 1 ]; then
  echo "ai-review: expected exactly one VERDICT line, found $COUNT; treat as inconclusive" >&2
  exit 2
fi
case "$LAST" in
  'VERDICT: APPROVE') exit 0 ;;
  'VERDICT: REQUEST_CHANGES')
    echo "ai-review: REQUEST_CHANGES — read the findings before pushing" >&2
    exit 1 ;;
  *)
    echo "ai-review: the last line is not a valid verdict: $LAST" >&2
    exit 2 ;;
esac

#!/usr/bin/env sh
# AI-assisted code review as a repeatable, local step.
#
#   scripts/ai-review.sh [--base <ref>] [--reviewer claude|codex] [--working-tree]
#
# Reviews `git diff <base>...HEAD` (or the uncommitted working tree with
# --working-tree) with the brief in scripts/ai-review-prompt.md, writes the
# review to reports/ai-review/<sha>-<reviewer>.md and exits 1 on
# `VERDICT: REQUEST_CHANGES`, so the same command works as a pre-push gate, a
# CI step, or a one-off second opinion. The AI is a reviewer, not an approver:
# a human still merges, and a REQUEST_CHANGES is a conversation, not a verdict.
set -eu

BASE="origin/main"
REVIEWER="claude"
WORKING_TREE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --reviewer) REVIEWER="$2"; shift 2 ;;
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
  DIFF="$(git diff --no-color -- $PATHSPEC)"
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

case "$REVIEWER" in
  claude)
    # Read-only tools so the reviewer can look around but never edit.
    printf '%s' "$INPUT" | claude -p --output-format text \
      --allowedTools "Read,Grep,Glob" > "$OUT"
    ;;
  codex)
    printf '%s' "$INPUT" | codex exec --sandbox read-only - > "$OUT"
    ;;
  *)
    echo "unknown reviewer: $REVIEWER (claude|codex)" >&2
    exit 2
    ;;
esac

echo "ai-review: $OUT"
if grep -q '^VERDICT: REQUEST_CHANGES' "$OUT"; then
  echo "ai-review: REQUEST_CHANGES — read the findings above before pushing" >&2
  exit 1
fi
grep -q '^VERDICT: APPROVE' "$OUT" || {
  echo "ai-review: no VERDICT line in the output; treat as inconclusive" >&2
  exit 1
}

# Git hooks

Versioned hooks, shared through `core.hooksPath` so every clone runs the same
gates instead of each developer keeping a private `.git/hooks` copy.

## Enable

```sh
npm run hooks:install   # git config core.hooksPath .githooks
```

This is a per-clone setting and it is not on by default. To disable it, run
`git config --unset core.hooksPath`.

## What runs

| Hook         | When         | Checks                                                                                                                      |
| ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | `git commit` | `prettier --check` and `eslint` on staged files only, then the shared and backend unit tests. Skips when nothing is staged. |
| `commit-msg` | `git commit` | The first line is a Conventional Commit: `type(scope)?!?: summary`. Merge, revert, `fixup!` and `squash!` messages pass.    |
| `pre-push`   | `git push`   | `npm run typecheck`, `npm run lint:deps` (architecture rules), `npm test`.                                                  |

Fast checks run on commit, and whole-repo checks run on push. That keeps a
commit under a few seconds while still stopping a broken branch from leaving
the machine.

## Bypassing

`git commit --no-verify` and `git push --no-verify` skip the hooks. That is
sometimes legitimate, such as a work-in-progress commit on a private branch.
CI runs the same checks again, so a bypass only delays the failure. A reviewer
should treat a pushed commit that fails these gates as a review flag and ask
why the hook was skipped.

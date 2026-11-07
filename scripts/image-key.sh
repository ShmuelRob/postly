#!/usr/bin/env bash
# Prints the content key of the images built from a commit (default HEAD) (docs/deployment.md, CI):
# the git hash of the commit's full tree listing without the paths that never enter an image, which
# are the same ones infra.yml's `changes` job treats as not touching the image: docs/, infra/ and
# top-level *.md. Commits with the same image inputs get the same key: a squash merge and its PR head,
# a promotion merge commit and the dev commit it brings, a docs-only or infra-only commit and its
# parent. The images are tagged `tree-<key>`, and Deploy builds only when that tag is missing.
set -euo pipefail
commit="${1:-HEAD}"
git rev-parse --verify --quiet "${commit}^{commit}" > /dev/null || { echo "image-key: no commit $commit" >&2; exit 1; }
git ls-tree -r --full-tree "$commit" \
  | awk -F '\t' '$2 !~ /^(infra\/|docs\/|[^\/]+\.md$)/' \
  | git hash-object --stdin

#!/usr/bin/env bash
# The image checks (docs/deployment.md, CI), run by infra.yml on PRs and by Deploy's `image` job on
# the image it pushes, before that image gets its `tree-<key>` tag: the product image runs as
# non-root and holds no test or playground code and no vitest, and the local stack (docker-compose.yml:
# Postgres, migrate, web, worker, on the simulators) starts from it and schedules the weekly tick as a
# singleton. Usage: scripts/check-image.sh <local image>. It never builds: compose runs that image.
set -euo pipefail
image="$1"

test "$(docker run --rm --entrypoint id "$image" -u)" != "0" || { echo "::error::the image runs as root"; exit 1; }
# `if`, not `! cmd`: bash's errexit ignores a negated command, so `! cmd` could never fail the script.
if docker run --rm --entrypoint sh "$image" -c 'find dist -name "*.test.*" -o -name playground | grep -q .'; then
  echo "::error::the image holds test or playground code"; exit 1
fi
if docker run --rm --entrypoint sh "$image" -c 'test -d node_modules/vitest'; then
  echo "::error::the image holds vitest"; exit 1
fi

# docker-compose.yml runs the image postly:local.
docker tag "$image" postly:local
trap 'docker compose -p ci logs --no-color || true; docker compose -p ci down -v || true' EXIT
docker compose -p ci up -d --no-build
for _ in $(seq 1 40); do curl -fsS localhost:8080/healthz && break; sleep 3; done
curl -fsS localhost:8080/healthz
docker compose -p ci exec -T postgres psql -U postgres -d postly -tAc \
  "select policy from pgboss.queue where name = 'weekly-update-tick'" | grep -qx singleton
echo "image checks passed: $image"

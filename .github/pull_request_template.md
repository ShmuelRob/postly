## What changed

<!-- The package (WP-xx or task), what changed and why, and anything left open. -->

## Lane

<!-- normal, docs-only (npm run lane:docs-only passes) or hotfix: docs/implementation-plan.md#change-size-lanes -->

## End-to-end report

<!-- For every e2e test added or changed: the test file, the report (CI artifact e2e-report, or the one sent with SendUserFile), and the result. "None" if no e2e test changed. -->

## Human-review areas

<!-- Tick every area this PR touches, and add docs/review-queue/pr-<N>.md for them (format: docs/review-queue/README.md). -->

- [ ] None
- [ ] Approval or publishing code (H5)
- [ ] RLS or tenant isolation
- [ ] Tokens, secrets or customer media (H8)
- [ ] Database migration (H4)
- [ ] Customer-facing prompt (H7) or copy (H6)
- [ ] CI, branch protection or merge rules
- Review-queue file: <!-- docs/review-queue/pr-<N>.md, or none -->

## Before deploy

- [ ] Needs `terraform apply` before deploy: <!-- the variables or resources, or leave unticked -->
- [ ] Has a migration: <!-- the file under drizzle/, or leave unticked -->

## Checks

- [ ] `npm run check:local` passed before pushing (CI runs `npm run check` and is the gate)
- [ ] `npm run fmt:infra` run, if `infra/` changed
- [ ] This PR does not edit `docs/implementation-plan.md` or its summary (manager PRs only)
- [ ] Hebrew companions updated for every changed doc

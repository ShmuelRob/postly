# Modules

Each module from [technical-design.md](../../docs/technical-design.md#modules) has a folder here:
`messaging`, `workflow`, `model-layer`, `content`, `design`, `publishing`, `business-data`, `billing`, `console`, and `agent` (WP-90; workflow calls it, it never imports workflow).

## Rules

The rules live in [.dependency-cruiser.mjs](../../.dependency-cruiser.mjs). `npm run check` runs them (`npm run lint:boundaries`), and CI blocks a merge on any violation.

| Rule | What it enforces |
| --- | --- |
| `module-internals` | A module's `index.ts` is its only public surface. Code in another module, or outside `src/modules/`, imports only `src/modules/<name>/index.ts`, never a file behind it. Type-only imports count too. |
| `vendor-outside-adapter` | A vendor SDK is imported only in its owning module's `adapters/` folder, for example `twilio` only in `src/modules/messaging/adapters/`. The vendor list per module is at the top of the config. |
| `db-driver-outside-db` | Database drivers (`pg`, `postgres`, `drizzle-orm/node-postgres`, and similar) are imported only in `src/db/`. |
| `db-internals` | Outside `src/db/`, code imports only `src/db/index.ts` (the business-context helper, `withBusiness()`, added in WP-20) and `src/db/schema.ts`. A connection or raw client never leaves `src/db/`. |

`src/contracts/` and `src/shared/` hold the contracts and generic helpers; any module may import them.

## Layout of a module

```text
src/modules/<name>/
  index.ts       public surface: export only what other modules need
  adapters/      vendor implementations of a provider interface from src/contracts/providers/
  ...            internal files, free to change without touching other modules
```

## Adding a module or a vendor

- New module: create `src/modules/<name>/index.ts`, add the name to the list in `boundaries.test.ts`, and add it to technical-design.md first if it is not there.
- New vendor SDK: add its package names under the owning module in `vendorPackages` in `.dependency-cruiser.mjs`, then import it only from that module's `adapters/`.
- New rule: add it to the config, seed a violating file under `test/fixtures/boundaries/`, and add the expected violation to `boundaries.test.ts`.

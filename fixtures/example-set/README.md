# Example set

The Hebrew example set the design engine and the model tasks are judged against ([design-styles.md](../../docs/design-styles.md#provisional-example-set), gate H3 in [implementation-plan.md](../../docs/implementation-plan.md#human-gates)). The six entries here are provisional and fictional: a florist, a bakery, a hair salon, a falafel stand, a pet shop, and a yoga studio. The human replaces them with the real set.

`src/example-set/` loads and validates the set: `loadExampleSet()` returns every entry or throws one error that lists every problem. `npx vitest run src/example-set` checks it.

## One folder per entry

```text
fixtures/example-set/<slug>/       folder name is the entry id, kebab-case (a-z, 0-9, -)
  entry.json                       provisional flag, business profile, photo list, expected outcomes
  weekly-update.txt                the owner's weekly update, exactly as sent (UTF-8)
  photos/<name>.svg|jpg|jpeg|png   1 to 10 photos
```

## entry.json

| Field | Content |
| --- | --- |
| `provisional` | `true` for drafted entries, `false` for entries the human supplied |
| `profile` | A complete `BusinessProfile` ([contracts.md](../../docs/contracts.md)); omitted optional fields get the PRD defaults |
| `photos[]` | `file` (path under `photos/`), `description` (what the photo shows, in English), and `placeholder` only for code-generated photos |
| `photos[].placeholder` | `width`, `height`, `colors` (gradient start, gradient end, shape color), `motif` (`circles`, `rings`, `petals`, `stripes`, `dots`, `arches`), `seed`. The file must be the SVG that `placeholderPhotoSvg()` draws from it |
| `expected.facts` | The `fact_extraction` output the update should produce: `id`, `type`, `value`, `sourceQuote`. Every `sourceQuote` must appear verbatim in `weekly-update.txt` |
| `expected.missingDetails` | Details the agent should ask the owner about, empty when none |
| `expected.overlayTexts` | Cover texts to render, each at most 2 lines (`\n`) and 40 characters |

## Adding a real entry

1. Create `<slug>/` with `entry.json`, `weekly-update.txt`, and the photos under `photos/`.
2. Set `provisional` to `false` and leave out `placeholder` on real photos.
3. Run `npx vitest run src/example-set`. The tests for the provisional set expect six provisional entries, so update them when the real set replaces it.

Photos must be owned by the business or licensed for this use; no third-party images.

## Regenerating placeholder photos

After changing a `placeholder` spec or the generator, rewrite the committed SVGs:

```bash
UPDATE_PLACEHOLDERS=1 npx vitest run src/example-set
```

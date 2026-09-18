# Expressions

Every fact, condition, and segment is a [JSONata](https://jsonata.org/) expression
evaluated against one profile version's document. This page covers what is in the
document, what rbx-pulse adds to JSONata, and recipes for common record shapes.

## Trying expressions

```sh
npm run pulse -- eval 'stats.xp' --record my-record.json --config config
npm run pulse -- eval '$count(purchases)' --record my-record.json --store purchases=my-purchases.json --config config
```

`--record` is the primary datastore's stored value as JSON. A DocumentService envelope is
detected and unwrapped; `--raw` skips that. `--store alias=file` mounts a supplemental
store exactly as `game.yaml` says. With `--config`, constants are available too.

Quoting: on Windows `cmd.exe` use double quotes around the expression. In PowerShell
and bash use single quotes, so `$` is not expanded by the shell.

## The document

The root is the primary record with its envelope removed and supplemental stores mounted
at their paths. Bindings:

| Binding | Contents |
|---|---|
| `$meta` | Envelope fields of the primary store, e.g. DocumentService's `lockTimestamp`, `dataSchemaVersion`. |
| `$entry` | Open Cloud metadata of the primary entry: `createTime` (first save, effectively install date), `revisionCreateTime` (last write), `observedAt`. ISO strings. |
| `$stores` | Every datastore by alias: `{ data, meta, entry }`. |
| `$<name>` | Each value from `constants.yaml`. |

A supplemental store the player has no entry in is absent. JSONata then behaves as it
would for a missing field: `$count(x)` is 0, `$sum(x.n)` is undefined, `x.n > 0` is
false, `$exists(x)` is false.

## Helpers

Lua serialises an empty table as `[]` even where a map is meant, and pads sparse arrays
with `false`. These helpers tolerate both.

| Helper | Returns |
|---|---|
| `$size(x)` | Number of keys in a map or elements in an array; 0 for `[]`, `{}` or missing. |
| `$entries(map)` | `[{key, value}]`; `[]` for an empty or missing map. |
| `$keysOf(map)` | The keys; `[]` when empty or missing. |
| `$has(arrayOrMap, v)` | True if an array contains `v` or a map has key `v` with a value other than `false`. |
| `$objects(array)` | Only the object elements; drops `false` placeholders. |
| `$fromUnix(n, unit?)` | Unix seconds (or `"millis"`) to an ISO string; undefined for 0 or missing. |
| `$default(x, fallback)` | `x` unless it is missing or null. For sums over an absent store. |

Standard JSONata functions all work: `$count`, `$sum`, `$min`, `$max`, `$string`,
`$substring`, `$toMillis`, `$fromMillis`, `$filter`, `$map`, and so on.

## Recipes

**A counter stored directly**

```yaml
- key: xp
  semantics: counter
  expr: stats.xp
```

**Level from an XP table in constants**

```yaml
# constants.yaml: levelThresholds: [0, 100, 250, 500, ...]
- key: level
  semantics: gauge
  expr: $count($levelThresholds[$ <= $$.xp])
```

`$$` is the document root, needed inside the filter where `$` is the array element.

**Count entries of a map that satisfy a condition**

```yaml
- key: codex_discovered
  semantics: counter
  expr: $count($entries(codex)[value.discovered = true])
```

**Sum a field across a map**

```yaml
- key: codex_pickups
  semantics: counter
  expr: $sum($entries(codex).value.pickupCount)
```

**One row per map key (keyed fact)**

```yaml
- key: quest_completed_at
  shape: keyed
  semantics: timestamp
  unit: seconds
  expr: '$entries(quests.completed).{ "dim": key, "value": value.lastCompletedAt }'
```

A plain map works too (`expr: building.built` gives one boolean row per building), as
does a list of strings (`expr: unlockedTools` gives a `true` row per tool).

**Items in a slot array with `false` placeholders**

```yaml
- key: inventory_used
  semantics: gauge
  expr: $count($objects(inventory.slots))
```

**Events from a rolling activity log**

```yaml
- key: activity
  shape: events
  unit: seconds
  expr: 'recentActivities.{ "type": t, "data": $string(d), "ts": ts }'
```

Each sync adds whatever is new in the log; duplicates are ignored by `(type, data, ts)`.

**A timestamped list in a supplemental store, with attributes**

```yaml
- key: purchase_count
  semantics: counter
  expr: $count(purchases)
- key: robux_spent
  semantics: counter
  expr: $default($sum(purchases.robuxSpent), 0)
- key: purchases_by_product
  shape: keyed
  semantics: counter
  expr: 'purchases{productKey: $count($)}'
- key: purchase_events
  shape: events
  unit: seconds
  expr: 'purchases.{ "type": "purchase", "data": productKey, "ts": at, "attrs": { "currency": currency, "robux": robuxSpent } }'
```

`attrs` is stored as JSON on the event and queried in SQL as `attrs->>'currency'`.

**A milestone with an exact time**

```yaml
- key: first_purchase
  when: $count(purchases) > 0
  at: $min(purchases.at)
```

**A milestone without a stored time**

```yaml
- key: reached_level_10
  when: $count($levelThresholds[$ <= $$.xp]) >= 10
```

Its time is reported as the interval between the last sync where it did not hold and
the write time of the first version where it did.

**Static cohort from the install date**

```yaml
- key: join_month
  label: $substring($entry.createTime, 0, 7)
```

**Banded dynamic cohort**

```yaml
- key: playtime_band
  label: >-
    timePlayed < 1800 ? "a_under_30m"
      : timePlayed < 7200 ? "b_30m_to_2h"
      : "c_over_2h"
```

Prefix labels so they sort in order in dashboards.

**Multi-line expressions with locals**

```yaml
- key: level_band
  label: >-
    ($l := $count($levelThresholds[$ <= $$.xp]);
     $l < 5 ? "01-04" : $l < 10 ? "05-09" : "10+")
```

YAML note: quote any expression containing `: ` or `#`, or use a `>-` block as above.

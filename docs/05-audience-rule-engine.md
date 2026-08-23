# 05 — Audience Rule Engine

The rule engine turns a **no-code rule definition** (JSON AST authored in the Audience Builder)
into **parameterized SQL** executed in Postgres. Nothing is evaluated in the browser and no
audience is ever materialized in application memory.

## 1. Rule AST

```ts
type RuleNode = RuleGroup | RuleCondition;

interface RuleGroup {
  type: 'group';
  operator: 'AND' | 'OR';
  negate?: boolean;            // NOT ( ... )
  children: RuleNode[];
}

interface RuleCondition {
  type: 'condition';
  field: FieldKey;             // from the field catalog, e.g. 'total_revenue', 'product_purchased'
  operator: Operator;          // eq | neq | gt | gte | lt | lte | between | in | not_in |
                               // is_null | is_not_null | contains | within_last | more_than_ago |
                               // between_ago | before | after | exists | not_exists
  value?: unknown;             // scalar | [min,max] | string[] | { value, unit } | { min,max,unit }
  params?: Record<string, unknown>; // field-specific (e.g. minCount, withinDays, openOnly)
  negate?: boolean;
}
```

Example — "High-value lapsed customers":

```json
{
  "type": "group", "operator": "AND", "children": [
    { "type": "condition", "field": "lifetime_value", "operator": "gte", "value": 10000 },
    { "type": "condition", "field": "order_count", "operator": "gte", "value": 3 },
    { "type": "condition", "field": "last_order_at", "operator": "more_than_ago", "value": { "value": 180, "unit": "days" } },
    { "type": "group", "operator": "OR", "negate": true, "children": [
      { "type": "condition", "field": "product_purchased", "operator": "in", "value": ["prod_123"], "params": { "withinDays": 30 } }
    ]}
  ]
}
```

Validation is done with `zod` (`packages/core/src/rules/schema.ts`): unknown fields, operators
not allowed for a field's data type, nesting deeper than 6 levels, more than 50 conditions,
or empty groups are rejected at `POST /audiences`.

## 2. Field catalog

The catalog (`packages/core/src/rules/fields.ts`) is the single place that defines what the
builder can show and what the compiler can compile. Each field declares:

| Property | Meaning |
|---|---|
| `key`, `label`, `group` | UI grouping: Customer · Purchase · Product · Behavior · Consent · Membership · Custom |
| `type` | `string` · `number` · `boolean` · `timestamp` · `enum` · `product` · `category` · `audience` |
| `operators` | allowed operators for the type |
| `column` | for scalar fields: the `customers` column |
| `subquery` | for set fields: how to compile an `EXISTS` against an aggregate table |
| `timeBand` | whether the field participates in incremental *time-boundary candidate extraction* |

Scalar fields compile to `c.<column> <op> $n`. Set fields compile to correlated `EXISTS`:

```sql
EXISTS (SELECT 1 FROM customer_product_purchases p
        WHERE p.customer_id = c.id AND p.product_id = ANY($1)
          AND p.last_purchased_at >= $now - $2::interval)
```

Relative-time operators compile against a **parameterized `now`** (`$now`), never `now()`, so
evaluation is deterministic and testable and a long-running job evaluates a single instant.

## 3. Compilation

`compileRule(ast, ctx) → { sql, params, timeBands, dependencies }`

* `sql` — a boolean expression that references the alias `c` (customers) only.
* `params` — positional values (`$1…$n`); `ctx.now` is injected as a parameter.
* `timeBands` — list of `{ source, column, offsetSeconds }` derived from every relative-time
  condition (e.g. `last_order_at more_than_ago 180d` → `{customers.last_order_at, 180d}`;
  `cart_events within_last 3d` → `{cart_events.occurred_at, 3d}`).
* `dependencies` — audience ids referenced by `in_audience` conditions, product/category ids
  (used for cache invalidation and for the dependency change feed).

Compilation is pure and has exhaustive unit tests (`rules/compiler.test.ts`). The compiled SQL
is cached on `audience_rules.compiled_sql` for inspection ("Show SQL" in the UI, read-only).

## 4. Evaluation modes

### Full evaluation (`FULL`)
Used on first activation and after a rule version change.

```sql
-- executed in keyset batches of 50k customers ordered by c.id, each in its own transaction
INSERT INTO audience_members (audience_id, customer_id, organization_id, status, entered_at, rule_version, last_evaluated_at)
SELECT $aud, c.id, c.organization_id, 'ACTIVE', $now, $ver, $now
FROM customers c
WHERE c.organization_id = $org AND c.id > $cursor AND c.id <= $cursor_end
  AND NOT c.deleted AND (<compiled predicate>)
ON CONFLICT (audience_id, customer_id) DO UPDATE SET status='ACTIVE', exited_at=NULL, ...
  WHERE audience_members.status <> 'ACTIVE';
-- afterwards: members whose last_evaluated_at < run start are EXITED (they no longer match)
```

### Incremental evaluation (`INCREMENTAL`) — the default
Runs on the audience's schedule (or when an event burst touches > N customers). Only
**candidates** are evaluated:

```
candidates =
    customers changed since watermark            (customers.updated_at ∈ (from, to])
  ∪ customers crossing a time boundary            (for each timeBand: column ∈ [from − offset, to − offset])
  ∪ customers whose membership in a dependency    (audience_membership_history of referenced audiences since from)
    audience changed
```

For each candidate the predicate is evaluated once; matches are upserted `ACTIVE`, non-matching
current members are flipped to `EXITED`. Every transition is appended to
`audience_membership_history`, which doubles as the change feed for downstream sync and for
dependent audiences. Watermarks are stored on `audience_eval_runs` and `audiences.last_evaluated_at`;
a run that fails leaves the watermark untouched, so the next run re-covers the same window
(idempotent upserts make this safe).

**Why this is correct:** a customer's membership can only change if (a) one of their
attributes/aggregates changed — marked by `updated_at`; (b) a relative-time predicate crossed
its boundary — captured by the time bands; or (c) a referenced audience's membership changed —
captured by the dependency feed. A nightly `RECONCILE` (full) run per audience is scheduled as
a safety net and is itself batched and idempotent.

## 5. Exclusions, suppression, consent and priority — where they apply

| Layer | Applied at | Why |
|---|---|---|
| Rule predicate | membership evaluation | produces the **source** set (`audience_members`) |
| Exclusions (`audience_exclusions`) | eligibility (preview + distribution) | always reflects the *current* membership of the excluded audiences without cascading re-evaluation |
| Suppression (`customers.suppressed`, `deleted`) | eligibility — hard override | a suppressed customer is never sent, regardless of any rule |
| Compliance policy (consent flags, regional rules, identifier requirements) | eligibility, per destination | policies differ per destination/jurisdiction |
| Holdout group | eligibility | control group is never sent |
| Priority (`audiences.priority`) | `audience_members.is_primary` recomputed incrementally; optional `primaryOnly` distribution policy | prevents conflicting campaigns |

The **preview** endpoint returns the full funnel for a rule definition without persisting
anything: total matches → excluded by audiences → suppressed → consent denied/unknown/expired
→ missing identifiers → duplicates → **estimated activation size**, plus historical sizes if
the audience already exists.

## 6. Templates

`packages/core/src/audience/templates.ts` ships 15 parameterized templates (Cart Abandoner,
Recent Purchaser, Lapsed, VIP, High LTV, One-time, Repeat, Product Buyer, Category Buyer,
Cross-sell, Winback, Replenishment, New Customer, Dormant, High AOV) and the standard recency
windows (`RECENT_PURCHASERS_1D/7D/30D`, `CART_ABANDONERS_1_3D/4_7D/8_14D`, `LAPSED_30/60/90/180/365D`,
`VIP`, `HIGH_VALUE`, `REPEAT`, `ONE_TIME`). A template is just a function producing a rule AST
plus recommended schedule, priority, exclusions and campaign recommendation.

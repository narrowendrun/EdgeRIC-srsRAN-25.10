# Plan 2 — Recorder schema v2

**Goal:** capture every `MacUeMetrics` field (MCS included), stop storing 239 MB of protobuf blobs
nothing reads, and make run statistics an O(1) lookup.

**Why now:** **MCS is not recorded.** `dl_mcs` and `ul_mcs` are fields 11 and 12 of `MacUeMetrics`
in `edgeric/protobufs/metrics.proto`, but `ue_mac` (`edgeric/metrics_recorder.py:32-46`) projects
only 8 metric columns. The metric you named as your primary numeric display has never been
captured. No amount of UI work can show it until this lands.

**Depends on:** nothing. **Blocks:** plans 3 and 4.

---

## 2.1 — What is missing today

`ue_mac` stores: `snr`, `cqi`, `dl_acked_bytes`, `ul_ok_bytes`, `dl_harq_ack`, `dl_harq_nack`,
`ul_crc_ok`, `ul_crc_fail`.

`MacUeMetrics` also carries, all currently discarded:

| Proto field | Type | Why you want it |
|---|---|---|
| `dl_mcs`, `ul_mcs` | uint32 | The metric this whole overhaul is for |
| `dl_prbs`, `ul_prbs` | uint32 | Resource allocation — essential for judging a custom scheduler |
| `dl_tbs`, `ul_tbs` | uint32 | Scheduled vs acknowledged bytes; the gap is retransmission overhead |
| `dl_buffer`, `ul_buffer` | uint32 | Queue occupancy — the input your scheduler reacts to |
| `avg_ce_delay_ms` and 5 siblings | float | MAC latency breakdown |

For a scheduling-algorithm project, `dl_prbs` and `dl_buffer` are arguably as important as MCS —
they are the allocation decision and the queue state that drove it.

## 2.2 — Design decision: always capture, never select

You described selection driving subscription: *"once I select, then start subbing and dumping to
sqlite."* This plan deliberately does **not** do that.

**Argument for decoupling:**

- The recorder already calls `ParseFromString` on the full protobuf every TTI. It has all 21 fields
  in memory whether or not it writes them. Writing more integer columns is cheap; *not* writing them
  saves almost nothing on the parse side.
- Dropping `raw_tti.payload` frees 239 MB of the 438 MB database — far more than the new columns
  cost. Net effect is a **smaller** database with **more** metrics in it.
- Selection-driven capture makes archives non-reproducible: what is in a run's database would depend
  on which checkboxes were ticked in a browser at the time. Two runs become incomparable.
- Un-ticking a metric mid-run would destroy data you cannot recover. OTA experiments are not cheap
  to repeat.
- It introduces a UI-to-recorder state channel that does not otherwise exist, and with it a whole
  class of "the dashboard thinks it is recording X but the recorder never got the message" bugs.

**What you lose:** nothing in the UX you described. Plan 4 delivers the exact picker, the exact
numeric/chart toggle, and the exact live/min/max/avg tiles. Selection simply becomes a read-side
filter, which also makes the query *cheaper* as you narrow it.

If you disagree, say so — the rest of the plans do not depend on this choice, only on the columns
existing.

## 2.3 — Schema v2

No in-place migration is needed: **every run creates a fresh database**, so v1 and v2 files simply
coexist in `logs/runs/`. Readers detect columns rather than assuming them (2.5).

`edgeric/metrics_recorder.py`, `open_database()`:

```sql
CREATE TABLE IF NOT EXISTS ue_mac (
    id                   INTEGER PRIMARY KEY,
    raw_tti_id           INTEGER,            -- nullable; only set when --store-raw
    timestamp_us         INTEGER NOT NULL,
    tti_index            INTEGER NOT NULL,
    rnti                 INTEGER NOT NULL,
    snr                  REAL    NOT NULL,
    cqi                  INTEGER NOT NULL,
    dl_mcs               INTEGER NOT NULL,
    ul_mcs               INTEGER NOT NULL,
    dl_prbs              INTEGER NOT NULL,
    ul_prbs              INTEGER NOT NULL,
    dl_tbs               INTEGER NOT NULL,
    ul_tbs               INTEGER NOT NULL,
    dl_buffer            INTEGER NOT NULL,
    ul_buffer            INTEGER NOT NULL,
    dl_acked_bytes       INTEGER NOT NULL,
    ul_ok_bytes          INTEGER NOT NULL,
    dl_harq_ack          INTEGER NOT NULL,
    dl_harq_nack         INTEGER NOT NULL,
    ul_crc_ok            INTEGER NOT NULL,
    ul_crc_fail          INTEGER NOT NULL,
    ce_delay_us          INTEGER NOT NULL,
    crc_delay_us         INTEGER NOT NULL,
    pucch_harq_delay_us  INTEGER NOT NULL,
    pusch_harq_delay_us  INTEGER NOT NULL,
    sr_to_pusch_delay_us INTEGER NOT NULL,
    sum_mac_delay_us     INTEGER NOT NULL
);
```

Two deliberate choices:

- **`raw_tti_id` drops its `REFERENCES` clause.** SQLite does not enforce foreign keys unless
  `PRAGMA foreign_keys=ON` (default off), so the old declaration was decorative. Making it a plain
  nullable integer is honest about what it is once raw storage is optional.
- **Delay fields are stored as microsecond integers, not milliseconds as REAL.** A `REAL` costs 8
  bytes per row unconditionally; a small integer costs 1–3. Across six columns and 1.5 M rows that
  is the difference between ~72 MB and ~18 MB. Convert with `int(round(ue.mac.avg_ce_delay_ms * 1000))`.

Bump the version marker the table already carries:

```python
database.execute("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '2')")
```

## 2.4 — Make raw protobuf storage opt-in

`raw_tti.payload` is **239 MB of the 438 MB** database. Grepping the whole server and client, the
only access to `raw_tti` anywhere is a `MIN/MAX(timestamp_us)` at
`server/services/metrics-query.ts:30`. The BLOBs themselves are never read by anything.

Keeping the option is reasonable — it is the only way to recover a field you forgot to project.
Making it the default is not.

```python
parser.add_argument("--store-raw", action="store_true",
                    help="Also persist the full protobuf payload for every TTI (large)")
```

In the receive loop:

```python
raw_tti_id = None
if args.store_raw:
    cursor = database.execute(
        "INSERT INTO raw_tti(timestamp_us, received_at_us, tti_index, payload) VALUES (?, ?, ?, ?)",
        (timestamp_us, received_at_us, tti_index, sqlite3.Binary(payload)),
    )
    raw_tti_id = cursor.lastrowid
```

`systemd/edgeric-metrics-recorder.service.in` keeps its current `ExecStart` — no `--store-raw`,
so the default is off. Re-run `systemd/install.sh` is **not** required for this change alone, but
is required if you add the flag back later.

## 2.5 — Readers detect columns instead of assuming them

`server/services/metrics-query.ts` must keep working against the two v1 databases already in
`logs/runs/`. Use `PRAGMA table_info` rather than the version number — it answers the question
directly ("does this column exist") and cannot drift from reality:

```ts
function availableColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(ue_mac)').all() as unknown as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}
```

Plan 3 intersects this set with the requested metrics. A v1 archive offers the original six
derived metrics; a v2 archive offers all twenty. The UI greys out the rest rather than erroring.

**Also fix the bounds query while here.** `metrics-query.ts:30` reads `MIN/MAX(timestamp_us)` from
`raw_tti` but selects rows from `ue_mac`. `raw_tti` has a row for every TTI including those with no
UEs, so the window end can sit past the last actual sample — and with raw storage off, the table is
empty and the query returns nothing at all. Move it:

```ts
const bounds = db.prepare(
  'SELECT MIN(timestamp_us) AS min_us, MAX(timestamp_us) AS max_us FROM ue_mac'
).get() as { min_us: number | null; max_us: number | null }
```

`idx_ue_mac_timestamp_rnti` makes `MIN`/`MAX` an index endpoint lookup, so this is faster than the
`raw_tti` version it replaces.

## 2.6 — Maintain statistics as you go

This turns plan 1's repair path from a table scan into a key lookup, and removes the 30 s timeout
concern entirely.

In `metrics_recorder.py`, track an in-memory RNTI set and a sample counter, and fold them into the
existing `commit_stats()`:

```python
observed_rntis: set[int] = set()
ue_samples = 0

# in the receive loop, after building the executemany rows:
ue_samples += len(message.ues)
for ue in message.ues:
    if ue.rnti not in observed_rntis:
        observed_rntis.add(ue.rnti)
        database.execute("INSERT OR IGNORE INTO observed_rnti(rnti) VALUES (?)", (int(ue.rnti),))
```

The `INSERT OR IGNORE` only fires on a genuinely new RNTI, so it costs nothing per TTI. Add to the
schema:

```sql
CREATE TABLE IF NOT EXISTS observed_rnti (rnti INTEGER PRIMARY KEY);
```

And add `"ue_samples": ue_samples` to the `commit_stats()` dictionary.

`server/scripts/metrics_stats.py` then becomes three key reads and a tiny table scan:

```python
def stat(key, default=0):
    row = database.execute("SELECT value FROM capture_stats WHERE key = ?", (key,)).fetchone()
    return int(row[0]) if row else default

ue_samples = stat("ue_samples")
if ue_samples == 0:   # v1 database, fall back to the scan
    ue_samples = database.execute("SELECT COUNT(*) FROM ue_mac").fetchone()[0]

try:
    rntis = [f"0x{r[0]:04X}" for r in database.execute("SELECT rnti FROM observed_rnti ORDER BY rnti")]
except sqlite3.OperationalError:   # v1 database
    rntis = [f"0x{r[0]:04X}" for r in database.execute("SELECT DISTINCT rnti FROM ue_mac ORDER BY rnti")]
```

The fallbacks keep the two existing archives readable.

## 2.7 — Storage impact

**Measured**, not estimated: I built the v2 schema above and wrote 240,000 rows through it with
the recorder's exact batching pattern (WAL, `synchronous=NORMAL`, commit every 250 rows or 250 ms).

Result: **98 bytes per row**, which projects to **148 MB** for the 1,504,194-row reference run.

| | v1 (measured) | v2 (measured) |
|---|---|---|
| `raw_tti` payloads | 239 MB | 0 (opt-in) |
| `raw_tti` row overhead + index | ~40 MB | 0 (opt-in) |
| `ue_mac` + index | ~159 MB | ~148 MB |
| **Total for the 757 s, 2-UE reference run** | **438 MB** | **~148 MB** |

A 66% reduction — better than the earlier estimate of ~320 MB. The 21-column v2 row is actually
*smaller* on disk than the 8-column v1 row, because SQLite stores small integers as 1–2 byte
varints while v1's per-row `raw_tti` join overhead was not free. Confirm on the first real v2 run
rather than trusting the projection.

Note this does **not** solve the ~2.3 GB/hour problem on its own, because `edgeric.log` is 121 MB
of that 535 MB and is untouched here. See plan 5.

## 2.8 — Order of operations

1. Edit `metrics_recorder.py` (schema, `--store-raw`, counters).
2. Edit `metrics_stats.py` (O(1) reads with v1 fallbacks).
3. Edit `metrics-query.ts` (`availableColumns`, bounds from `ue_mac`).
4. `sudo systemctl restart edgeric-metrics-recorder` — or just start the next run; the unit file
   is unchanged so no `install.sh` re-run is needed.

## Verification

1. Start a short run, connect a UE, stop. Confirm with:
   ```
   sqlite3 logs/runs/<new-id>/metrics.sqlite3 \
     "SELECT value FROM metadata WHERE key='schema_version';
      SELECT COUNT(*) FROM raw_tti;
      SELECT rnti, dl_mcs, ul_mcs, dl_prbs, dl_buffer FROM ue_mac LIMIT 5;
      SELECT * FROM observed_rnti;"
   ```
   Expect `2`, `0`, five rows with plausible MCS (0–28) and PRB values, and your RNTIs.
2. Confirm the archive still renders both **v1** runs without error.
3. Compare `du -h` on the new database against the old one per minute of capture.
4. Sanity-check MCS against the gNB's own view in the `gnb` log tab during the run.

## Risk

Low-to-moderate. The recorder is the one component where a mistake costs you an OTA session.
Mitigations: schema v1 files are untouched and still readable; the change is additive apart from
the raw-payload default; and step 2.8's verification is a two-minute local run before any real
experiment.

**One thing to watch:** if any `MacUeMetrics` field is absent from a message, protobuf proto3
returns the zero value rather than raising — so a mis-wired gNB shows as a column of zeros, not as
an error. Spot-check MCS against the gNB log on the first run.

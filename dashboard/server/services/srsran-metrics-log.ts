/**
 * Parser for the srsRAN gNB's own periodic metrics lines, as captured in a run's gnb.log.
 *
 * These are the reference this dashboard's aggregates must agree with. The layout is:
 *
 *   pci rnti | cqi  ri  mcs  brate   ok  nok  (%)  dl_bs | pusch rsrp  ri  mcs  brate  ok  nok  (%)  bsr  ta  phr
 *     1 4602 |  10 1.0   16    85k    6    0   0%      3 |  28.2 -21.6  1   27   282k   5    0   0%    0 284n  -5
 *
 * `pusch` (UL SNR) reads `n/a` when there was no PUSCH in the period -- which is precisely the
 * distinction our own aggregates need to honour.
 */

export interface SrsranMetricRow {
  timestampMs: number
  pci: number
  rnti: number
  dl: { cqi: number | null; mcs: number; brateBps: number; ok: number; nok: number }
  ul: { snr: number | null; mcs: number; brateBps: number; ok: number; nok: number }
}

const NUM = String.raw`[-\d.]+|n/a`
const LINE = new RegExp(
  String.raw`^(\S+)\s+\S+\s+\S+\[\d+\]:\s+` +
  String.raw`(\d+)\s+([0-9a-fA-F]+)\s+\|` +                                  // pci rnti
  String.raw`\s+(${NUM})\s+(${NUM})\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\S+)\s+\|` + // dl
  String.raw`\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+\d+%`,    // ul
)

function optional(value: string): number | null {
  return value === 'n/a' ? null : Number(value)
}

/** srsRAN abbreviates bit rates as e.g. `0`, `43.5k`, `1.2M`. */
export function parseBitRate(value: string): number {
  if (value === 'n/a' || value === '0') return 0
  const m = /^([\d.]+)([kMG]?)$/.exec(value)
  if (!m) return 0
  return Number(m[1]) * ({ '': 1, k: 1e3, M: 1e6, G: 1e9 }[m[2]] ?? 1)
}

export function parseSrsranMetricsLog(text: string): SrsranMetricRow[] {
  const rows: SrsranMetricRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (!m) continue
    const timestampMs = Date.parse(m[1])
    if (Number.isNaN(timestampMs)) continue
    rows.push({
      timestampMs,
      pci: Number(m[2]),
      rnti: parseInt(m[3], 16),
      dl: { cqi: optional(m[4]), mcs: Number(m[6]), brateBps: parseBitRate(m[7]), ok: Number(m[8]), nok: Number(m[9]) },
      ul: { snr: optional(m[11]), mcs: Number(m[14]), brateBps: parseBitRate(m[15]), ok: Number(m[16]), nok: Number(m[17]) },
    })
  }
  return rows
}

/** srsRAN's own DL BLER over a set of rows: nok / (ok + nok). */
export function blerOf(rows: Array<{ ok: number; nok: number }>): number | null {
  const ok = rows.reduce((sum, r) => sum + r.ok, 0)
  const nok = rows.reduce((sum, r) => sum + r.nok, 0)
  return ok + nok > 0 ? (nok / (ok + nok)) * 100 : null
}

/** Mean MCS over the rows srsRAN actually transmitted on. */
export function meanMcsWhenTransmitting(rows: Array<{ mcs: number; ok: number; nok: number }>): number | null {
  const active = rows.filter((r) => r.ok + r.nok > 0 && r.mcs > 0)
  if (active.length === 0) return null
  return active.reduce((sum, r) => sum + r.mcs, 0) / active.length
}

/** Mean of a numeric field across rows, skipping nulls. Returns null when nothing is present. */
export function meanOf(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null
}

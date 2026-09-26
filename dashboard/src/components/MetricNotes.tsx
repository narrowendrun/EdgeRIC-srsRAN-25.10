import { METRICS, requiredColumns, type MetricDef, type MetricGroup } from '../../server/metrics-registry'

const groupOrder: MetricGroup[] = ['Radio', 'Throughput', 'Reliability', 'Scheduling', 'Latency']

/** Renders the registry's SQL predicate as something a human reads. */
function countedOn(metric: MetricDef): string {
  if (metric.source === 'harq') return 'native slots and resolved initial HARQ transmissions'
  if (!metric.definedWhen) return 'every TTI'
  if (metric.definedWhen.includes('dl_prbs')) return 'TTIs with a DL allocation'
  if (metric.definedWhen.includes('ul_prbs')) return 'TTIs with a UL grant'
  if (metric.definedWhen.includes('ul_crc')) return 'TTIs with a PUSCH'
  return metric.definedWhen
}

function combinedBy(metric: MetricDef): string {
  if (metric.source === 'harq') {
    return metric.key.includes('SuccessProbability')
      ? 'successful ÷ resolved initial transmissions'
      : 'native-slot AoI recurrence'
  }
  switch (metric.agg) {
    case 'avg': return 'mean over the bucket'
    case 'rate': return 'bytes × 8 ÷ elapsed time'
    case 'ratio': return 'share of events, as a percentage'
  }
}

export function MetricNotes() {
  return <section className="metric-notes">
    <div className="section-heading">
      <div><p className="section-kicker">how the numbers are made</p><h2>Metric notes</h2></div>
    </div>

    <div className="notes-prose paper-note">
      <h3>The gNB is the reference</h3>
      <p>
        Every aggregate is defined to agree with what the srsRAN gNB reports in its own metrics
        log, which is captured as <code>gnb.log</code> in each run directory. A test parses that
        log and asserts our numbers against it, so the two cannot drift apart silently.
      </p>
      <div className="notes-map">
        <div><code>dlBler</code> <span>↔</span> <code>(%)</code></div>
        <div><code>dlMbps</code> / <code>ulMbps</code> <span>↔</span> <code>brate</code></div>
        <div><code>snr</code> <span>↔</span> <code>pusch</code></div>
        <div><code>dlMcs</code> / <code>ulMcs</code> <span>↔</span> <code>mcs</code></div>
        <div><code>cqi</code> <span>↔</span> <code>cqi</code></div>
      </div>

      <h3>Why some metrics skip TTIs</h3>
      <p>
        The gNB writes <code>mcs = 0</code>, <code>prbs = 0</code> and <code>tbs = 0</code> on a TTI
        it did not schedule, and prints <code>n/a</code> for SNR when no PUSCH arrived. Those are
        absences, not measurements. Averaging them in is badly misleading: on a real run where 91%
        of TTIs carried no DL allocation, including them reported an average MCS of
        <strong> 1.4</strong> where the gNB reported <strong>15</strong>. Each metric below states
        which TTIs it counts.
      </p>

      <h3>How averages are weighted</h3>
      <p>
        A window average weights every qualifying TTI equally. That answers <em>what did the radio
        look like while data was moving</em>. Averaging the rows of the gNB log instead weights
        each metrics period equally and answers <em>what did the channel look like over time</em>;
        the two differ whenever activity is bursty — 24.4 dB against 26.9 dB for SNR on one
        recorded run. Neither is wrong, and the gNB publishes no window aggregate of its own, so
        this is a choice rather than a match. Chart values are unaffected: per bucket they agree
        with the gNB.
      </p>

      <h3>Bucketing, gaps, and peaks</h3>
      <p>
        A window is downsampled to a few hundred buckets, so peak values are bounded by bucket
        width — the gNB's 100 ms periods saw a 17.4 Mbps peak where a 900 ms bucket saw 15.8.
        Narrow the window for finer resolution. A bucket containing no qualifying TTI omits the
        metric entirely, so a chart line breaks rather than dipping to the floor, and throughput
        divides by the span a bucket actually covers rather than its nominal width.
      </p>

      <h3>Capture is not display</h3>
      <p>
        Every metric is recorded for every run regardless of what is selected here; the picker is a
        display filter. Each run directory also carries a <code>metrics-schema.json</code>
        describing these definitions, so an archived run stays interpretable elsewhere —
        <code>server/scripts/export_run.py</code> uses it to produce analysis-ready CSV.
      </p>
    </div>

    {groupOrder.map((group) => <section className="notes-group" key={group}>
      <h3>{group}</h3>
      <div className="notes-grid">
        {METRICS.filter((m) => m.group === group).map((metric) => <article className="paper-note note-card" key={metric.key}>
          <div className="chart-title"><h4>{metric.label}</h4><span>{metric.unit}</span></div>
          {metric.note && <p className="note-text">{metric.note}</p>}
          <dl className="note-facts">
            <div><dt>key</dt><dd><code>{metric.key}</code></dd></div>
            <div><dt>source</dt><dd><code>{requiredColumns(metric).join(', ')}</code></dd></div>
            <div><dt>combined by</dt><dd>{combinedBy(metric)}</dd></div>
            <div><dt>counted on</dt><dd>{countedOn(metric)}</dd></div>
            {metric.domain && <div><dt>range</dt><dd>{metric.domain[0]}–{metric.domain[1]}</dd></div>}
          </dl>
        </article>)}
      </div>
    </section>)}
  </section>
}

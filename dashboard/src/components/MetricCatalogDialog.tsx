import { useEffect, useRef, useState } from 'react'

interface Field { name: string; type: string; repeated: boolean; description: string }
interface Message { name: string; fields: Field[] }
interface Channel { endpoint: string; transport: string; rootMessage: string; note?: string; messages: Message[] }
interface Catalog { published: Channel[]; subscribed: Channel[] }

export function MetricCatalogDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetch('/api/metrics/catalog').then(async (response) => {
      if (!response.ok) throw new Error('Metric catalog is unavailable')
      setCatalog(await response.json())
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Metric catalog is unavailable'))
  }, [])

  return <>
    <button type="button" className="info-button" aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}>
      <span className="info-glyph" aria-hidden="true">i</span> EdgeRIC metrics
    </button>
    <dialog className="details-dialog metric-dialog" ref={dialogRef} onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current.close() }}>
      <div className="details-paper">
        <div className="dialog-heading"><div><p className="section-kicker">protobuf channel catalog</p><h2>Published and subscribed metrics</h2></div><button type="button" onClick={() => dialogRef.current?.close()}>Close <span aria-hidden="true">×</span></button></div>
        {error && <p className="notice notice-error">{error}</p>}
        {!catalog && !error && <p className="empty-state">Loading schema…</p>}
        {catalog && <div className="catalog-columns">
          <CatalogGroup title="gNB publishes" channels={catalog.published} />
          <CatalogGroup title="gNB subscribes" channels={catalog.subscribed} />
        </div>}
      </div>
    </dialog>
  </>
}

function CatalogGroup({ title, channels }: { title: string; channels: Channel[] }) {
  return <section><h3>{title}</h3>{channels.map((channel) => <article className="catalog-channel" key={channel.endpoint}>
    <p><strong>{channel.rootMessage}</strong><code>{channel.endpoint}</code><small>{channel.transport}</small></p>
    {channel.note && <p className="catalog-note">{channel.note}</p>}
    {channel.messages.map((message) => <details key={message.name} open={message.name === channel.rootMessage}>
      <summary>{message.name} <span>{message.fields.length} fields</span></summary>
      <div className="catalog-fields">{message.fields.map((field) => <div key={field.name}><code>{field.name}</code><span>{field.repeated ? 'repeated ' : ''}{field.type}</span><small>{field.description}</small></div>)}</div>
    </details>)}
  </article>)}</section>
}

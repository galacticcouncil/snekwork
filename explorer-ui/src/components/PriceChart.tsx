/* eslint-disable react-refresh/only-export-components -- chart component + ema7/bucketing helpers */
import { useMemo, useRef, useState } from 'react'
import { performancePoints } from './performance'
import { UNFILTERED_COLOR } from './activityColors'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { ChartTip, F } from './ui'

const W = 820, H = 190, padTop = 14, padBot = 14
// The price line takes the neutral slate this app reserves for series that are not
// an activity category (the same one /blocks uses), rather than an up/down valence
// red and green. Trend is not lost — the performance chips above the plot carry it,
// in color.
const LINE_COLOR = UNFILTERED_COLOR
// How many buckets the pointer can address. A bucket narrower than a few pixels
// cannot be aimed at. 390px phones get a third of the plot width of a desktop, so
// they bucket coarser at the same breakpoint the stylesheet uses.
const MAX_BUCKETS = 180
const MAX_BUCKETS_NARROW = 80

export type BucketSize = 'day' | 'week' | 'month'

// The finest bucket whose count the plot can still address. A 3-year daily series
// is ~1px per day at desktop width: the crosshair would land on whichever day the
// pointer's integer pixel happened to round to. Weekly (and monthly, past ~3.5
// years) restores a bucket the pointer can actually hit.
export function chooseBucketSize(pointCount: number, maxBuckets: number): BucketSize {
  if (pointCount <= maxBuckets) return 'day'
  if (Math.ceil(pointCount / 7) <= maxBuckets) return 'week'
  return 'month'
}

// A contiguous run of daily points shown as one x slot. `mid` is the point the
// crosshair reports and pins its dot to: the middle of the span, so the marker sits
// over the middle of the span rather than at its edge.
export interface ChartBucket { i0: number; i1: number; mid: number; label: string }

function utcWeekKey(date: string): string {
  const t = Date.parse(date.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(t)) return date.slice(0, 10)
  const d = new Date(t)
  // Monday-anchored, so a bucket is a calendar week rather than an offset from
  // whichever day the asset's history happens to start on.
  const shift = (d.getUTCDay() + 6) % 7
  return new Date(t - shift * 86_400_000).toISOString().slice(0, 10)
}

// Buckets over the daily series, in order. Labels name the span the tooltip is
// reporting — a bucket covering seven days must not present itself as one date.
export function buildBuckets(dates: string[] | undefined, n: number, size: BucketSize): ChartBucket[] {
  const dayOf = (i: number) => dates?.[i]?.slice(0, 10) ?? ''
  if (!dates || dates.length !== n || size === 'day') {
    return Array.from({ length: n }, (_, i) => ({ i0: i, i1: i, mid: i, label: dayOf(i) }))
  }
  const keyOf = size === 'week' ? utcWeekKey : (d: string) => d.slice(0, 7)
  const out: ChartBucket[] = []
  let key = ''
  for (let i = 0; i < n; i++) {
    const k = keyOf(dates[i])
    if (k !== key || !out.length) { out.push({ i0: i, i1: i, mid: i, label: '' }); key = k }
    else out[out.length - 1].i1 = i
  }
  for (const b of out) {
    b.mid = (b.i0 + b.i1) >> 1
    const from = dayOf(b.i0), to = dayOf(b.i1)
    // A one-point bucket is a single date; a span says so, dropping the redundant
    // year/month from its end ("2025-02-03 – 02-09").
    b.label = size === 'month' ? from.slice(0, 7)
      : from === to ? from
        : `${from} – ${to.slice(from.slice(0, 4) === to.slice(0, 4) ? 5 : 0)}`
  }
  return out
}

// Asset price chart with an EMA7 overlay, an availability-based performance row,
// and a crosshair tooltip reading price and EMA over one span.
export function PriceChart({ data, dates, price, change24h }: {
  data: number[]; dates?: string[]; price: number | null; change24h: number | null
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ k: number; xPct: number; yPct: number; label: string; price: string; ema: string } | null>(null)
  const narrow = useMediaQuery('(max-width: 720px)')

  // Pure geometry over the series: two path strings a thousand-odd points long, the
  // EMA pass, the bucketing and the performance row. It
  // changes only when the series does, but the page around this chart re-renders
  // once a second on the shared clock, so without the memo the whole lot is rebuilt
  // every tick — and again on every crosshair move.
  const geom = useMemo(() => {
    if (!data || data.length < 2) return null
    const n = data.length
    const min = Math.min(...data), max = Math.max(...data)
    // Span full width so the line/EMA align with the hover crosshair (0..100% across
    // the container); a horizontal inset leaves the first/last points hoverable but
    // with no line drawn there.
    const sx = (i: number) => i / (n - 1) * W
    const sy = (v: number) => padTop + (1 - (v - min) / ((max - min) || 1)) * (H - padTop - padBot)
    // The LINE stays at full daily resolution — it is a path, so its detail costs no
    // addressability, and a week-smoothed curve would hide the volatility that is
    // the point of a price chart. Only the readout buckets.
    const line = data.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
    const area = `${line} L ${sx(n - 1).toFixed(1)} ${H - padBot} L ${sx(0).toFixed(1)} ${H - padBot} Z`
    const col = LINE_COLOR

    // EMA7 over the DAILY closes, so it stays a 7-day average however the readout
    // buckets; the tooltip samples it at the bucket's close.
    const k = 2 / 8
    const ema: number[] = []
    data.forEach((v, i) => ema.push(i ? v * k + ema[i - 1] * (1 - k) : v))
    const emaLine = ema.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')

    const dated = dates && dates.length === data.length ? dates : undefined
    const size = chooseBucketSize(n, narrow ? MAX_BUCKETS_NARROW : MAX_BUCKETS)
    const buckets = buildBuckets(dated, n, size)
    const bucketOfPoint = new Int32Array(n)
    buckets.forEach((b, kIdx) => { for (let i = b.i0; i <= b.i1; i++) bucketOfPoint[i] = kIdx })

    // perf reads the daily series, so the chips keep their exact windows.
    const perfItems = [
      ...(change24h != null ? [{ label: '24H', value: change24h }] : []),
      ...performancePoints(data, dated),
    ]
    return { n, sx, sy, line, area, col, ema, emaLine, dated, perfItems, last: data[n - 1], buckets, bucketOfPoint }
  }, [data, dates, change24h, narrow])

  if (!geom) return null
  const { n, sx, sy, line, area, col, ema, emaLine, perfItems, last, buckets, bucketOfPoint } = geom

  const perf = (label: string, val: number) => (
    <span key={label} className="perf"><span className="pk">{label}</span><span className="pv" style={{ color: val >= 0 ? 'var(--green)' : 'var(--red)' }}>{val >= 0 ? '+' : ''}{val.toFixed(2)}%</span></span>
  )

  function onMove(e: React.PointerEvent) {
    const wrap = wrapRef.current; if (!wrap) return
    const r = wrap.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    // Snap to the bucket under the pointer and report its middle — the crosshair
    // stops centred on a span, instead of on whichever day a pixel rounded to.
    const bucket = buckets[bucketOfPoint[Math.round(frac * (n - 1))]]
    const i = bucket.mid
    setHover({
      k: bucketOfPoint[i], xPct: sx(i) / W * 100, yPct: sy(data[i]) / H * 100,
      label: bucket.label, price: F.priceUsd(data[i]), ema: F.priceUsd(ema[i]),
    })
  }

  return (
    <div className="pf-card">
      <div className="pf-head pf-head-asset">
        <div className="pf-now">{F.priceUsd(price ?? last)}</div>
        <div className="perf-row">{perfItems.map(p => perf(p.label, p.value))}</div>
      </div>
      {/* Same pointer wiring as AreaChart (ui.tsx): touch scrubs, tap sticks, mouse leave clears. */}
      <div className="apx-wrap" ref={wrapRef} onPointerDown={onMove} onPointerMove={onMove}
        onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
        <svg className="apx-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs><linearGradient id="apxg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.26" /><stop offset="100%" stopColor={col} stopOpacity="0" /></linearGradient></defs>
          <path d={area} fill="url(#apxg)" />
          <path d={emaLine} fill="none" stroke="var(--lavender)" strokeWidth="1.4" strokeDasharray="4 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {hover && <div className="apx-cross"><div className="apx-vline" style={{ left: `${hover.xPct}%` }} /><div className="apx-dot" style={{ left: `${hover.xPct}%`, top: `${hover.yPct}%` }} /></div>}
        {hover && (
          <ChartTip xPct={hover.xPct}>
            <span className="t-d">{hover.label}</span>
            <span className="t-p">{hover.price}</span>
            <span className="t-e">EMA {hover.ema}</span>
          </ChartTip>
        )}
      </div>
      <div className="bal-legend" style={{ marginTop: 10 }}>
        <span><i style={{ background: col }} />Price</span>
        <span><i style={{ background: 'var(--lavender)' }} />EMA7</span>
      </div>
    </div>
  )
}

// EMA7 of a series (for the detail-card price tag).
export function ema7(data: number[]): number | null {
  if (!data?.length) return null
  const k = 2 / 8
  let e = data[0]
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k)
  return e
}

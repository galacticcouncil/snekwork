/* eslint-disable react-refresh/only-export-components -- chart primitives + shared formatting helpers (mirrors ui.tsx) */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { compactAmount } from './ui'

/* ============ formatting ============ */
// Compact token amount — the shared explorer-wide rough scale (1.56B · 797M ·
// 12.6k · 537 · 0.0₅7191), centralized in ui.tsx.
export function fmtTokens(v: number): string {
  return compactAmount(v)
}

// Compact form for on-bar clamp labels: whole millions once past ~10M, so the
// value labels on adjacent clamped columns keep clear space between them
// (147.94M → "148M"). Billions still collapse via fmtTokens (1.61B).
export function fmtTokensTick(v: number): string {
  return Math.abs(v) >= 1e7 ? fmtTokens(Math.round(v / 1e6) * 1e6) : fmtTokens(v)
}

/* ============ legend ============ */
// Small legend row: colored dot + label (GeistMono 11px, reuses .bal-legend).
export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="bal-legend" style={{ margin: '0 0 10px' }}>
      {items.map(it => <span key={it.label}><i style={{ background: it.color }} />{it.label}</span>)}
    </div>
  )
}

// Clamp a tooltip's left % so a translateX(-50%) tip doesn't spill the card edge.
function tipLeft(pct: number): string { return `${Math.min(91, Math.max(9, pct))}%` }

// Touch has no hover-out: a tapped tooltip deliberately stays open so it can be
// read after the finger lifts, but it then needs a way OFF the screen. Clear it
// when the next pointerdown lands anywhere outside the chart (the capture phase
// beats stopPropagation in whatever was tapped instead).
function useClearOnOutsidePointer(clear: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  // `clear` is an inline arrow, so the listener re-subscribes per render — but
  // only while a tooltip is open, and renders then only happen on hover moves.
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const el = ref.current
      if (el && e.target instanceof Node && !el.contains(e.target)) clear()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active, clear])
  return ref
}

/* ============ 100%-stacked horizontal share bar ============ */
export interface ShareSegment { key: string; label: string; color: string; value: number; tip: ReactNode }

// Rounded 8px outer ends via clipPath; 2px card-background gaps between segments
// (stroke with var(--bg-elev)); per-segment hover tooltip below the bar.
export function ShareBar({ segments, h = 44 }: { segments: ShareSegment[]; h?: number }) {
  const clipId = useId()
  const [hover, setHover] = useState<{ leftPct: number; tip: ReactNode } | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const segs = segments.filter(s => s.value > 0)
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (!segs.length || total <= 0) return <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, padding: '12px 0' }}>No data.</div>
  const offsets: number[] = []
  for (let i = 0, run = 0; i < segs.length; i++) { offsets.push(run); run += segs[i].value }
  const rects = segs.map((s, i) => ({ ...s, x0: offsets[i] / total * 100, w: s.value / total * 100 }))
  return (
    <div ref={wrapRef} className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg width="100%" height={h} role="img">
        <defs><clipPath id={clipId}><rect x="0" y="0" width="100%" height={h} rx="8" /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          {rects.map(s => (
            <rect
              key={s.key} x={`${s.x0}%`} y="0" width={`${s.w}%`} height={h} fill={s.color}
              stroke={rects.length > 1 ? 'var(--bg-elev)' : 'none'} strokeWidth={2}
              onMouseEnter={() => setHover({ leftPct: s.x0 + s.w / 2, tip: s.tip })}
            />
          ))}
        </g>
      </svg>
      {hover && <div className="chart-tip" style={{ left: tipLeft(hover.leftPct), top: h + 8 }}>{hover.tip}</div>}
    </div>
  )
}

// Round a cap up to a tidy axis ceiling. Only two gridlines are drawn — the top
// and its midpoint — so we round the MIDPOINT up to a clean unit (a quarter of
// the leading decade: 25M at the 100M scale, 2.5M at the 10M scale, …) and set
// the top to exactly twice it. Both lines then land on round numbers that step
// evenly with no gaps (midpoints 75M · 100M · 125M · 150M …, tops 150M · 200M ·
// 250M · 300M …), and the rule scales to any magnitude.
export function niceAxisMax(v: number): number {
  if (!(v > 0)) return 1
  const decade = 10 ** Math.floor(Math.log10(v) + 1e-9)
  const unit = decade / 4
  const mid = Math.ceil(v / 2 / unit - 1e-9) * unit
  return mid * 2
}

/* ============ stacked area (pool composition over time) ============ */
// `hatch` overlays a faint light diagonal texture on the band's fill and a
// light halo under its top edge — for near-black brand bands that would
// otherwise vanish into a dark background. The light marks disappear on light
// surfaces, where the black fill carries itself.
export interface AreaSeries { key: string; label: string; color: string; values: (number | null)[]; hatch?: boolean }

// Cumulative stack tops, bottom-up in the order given (largest first from the
// API). A null contributes nothing to its bucket — the band is absent there,
// not zero-thick by fiat — while the numbers stay null for the tooltip.
export function stackSeries(series: AreaSeries[]): { tops: number[][]; max: number } {
  const n = series[0]?.values.length ?? 0
  const tops: number[][] = []
  let prev = new Array<number>(n).fill(0)
  for (const s of series) {
    const top = prev.map((v, i) => v + (s.values[i] ?? 0))
    tops.push(top)
    prev = top
  }
  const max = prev.reduce((m, v) => (v > m ? v : m), 0)
  return { tops, max }
}

const monthTick = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', ' ’') : d
}
// Four evenly spaced x-axis date ticks (first/last + thirds).
function dateTicks(n: number): number[] {
  if (n < 2) return []
  return [...new Set([0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])]
}

// Stacked area chart on a continuous daily axis: pool/asset composition over
// time. Bands are the series' own (icon-sampled) colors — identity follows the
// token, exactly like ShareBar — with a 2px top edge in the band color over a
// translucent fill so adjacent bands separate without a synthetic gap. Axis and
// hover follow StackedColumnChart / AreaChart conventions; no animation.
// `showShare={false}` drops the tooltip's per-bucket share suffix — a chart
// already plotting shares (100%-stacked mode) would repeat every value.
export function StackedAreaChart({ buckets, series, h = 220, yFmt = fmtTokens, showShare = true }: {
  buckets: string[]; series: AreaSeries[]; h?: number; yFmt?: (v: number) => string; showShare?: boolean
}) {
  const hatchId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const n = buckets.length
  const { tops, max: rawMax } = stackSeries(series)
  if (n < 2 || !series.length || !(rawMax > 0)) return <div className="muted" style={{ padding: '24px 0', fontFamily: 'GeistMono', fontSize: 12 }}>Not enough history.</div>
  const max = niceAxisMax(rawMax)
  const W = 860, padL = 46, padR = 6, padT = 12, padB = 18
  const plotW = W - padL - padR, plotH = h - padT - padB
  const sx = (i: number) => padL + (i / (n - 1)) * plotW
  const sy = (v: number) => padT + (1 - v / max) * plotH
  const bands = series.map((s, k) => {
    const top = tops[k]
    const bottom = k === 0 ? null : tops[k - 1]
    const fwd = top.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
    const back = bottom
      ? [...bottom.keys()].reverse().map(i => `L ${sx(i).toFixed(1)} ${sy(bottom[i]).toFixed(1)}`).join(' ')
      : `L ${sx(n - 1).toFixed(1)} ${sy(0).toFixed(1)} L ${sx(0).toFixed(1)} ${sy(0).toFixed(1)}`
    return { s, area: `${fwd} ${back} Z`, edge: fwd }
  })
  function onMove(e: React.PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!r.width) return
    const x = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((x - padL) / plotW) * (n - 1))
    setHover(Math.min(n - 1, Math.max(0, i)))
  }
  const hoverTotal = hover != null ? series.reduce((s, x) => s + (x.values[hover] ?? 0), 0) : 0
  return (
    <div ref={wrapRef} className="chart-wrap apx-wrap" onPointerDown={onMove} onPointerMove={onMove}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`}>
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={sy(max * t).toFixed(1)} y2={sy(max * t).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="chart-ax" x={padL - 8} y={(sy(max * t) + 3).toFixed(1)} textAnchor="end">{yFmt(max * t)}</text>
          </g>
        ))}
        {series.some(x => x.hatch) && (
          <defs>
            <pattern id={hatchId} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,0.28)" strokeWidth="1.6" />
            </pattern>
          </defs>
        )}
        {bands.map(({ s, area, edge }) => (
          <g key={s.key}>
            <path d={area} fill={s.color} fillOpacity={0.42} />
            {s.hatch && <path d={area} fill={`url(#${hatchId})`} />}
            {s.hatch && <path d={edge} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="4.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
            <path d={edge} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {dateTicks(n).map(i => (
          <text key={i} className="chart-ax" x={sx(i).toFixed(1)} y={h - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{monthTick(buckets[i])}</text>
        ))}
        {hover != null && <line x1={sx(hover).toFixed(1)} x2={sx(hover).toFixed(1)} y1={padT} y2={h - padB} stroke="var(--text-medium)" strokeOpacity="0.55" />}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: tipLeft(sx(hover) / W * 100), top: 2 }}>
          <span className="t-d">{buckets[hover]}</span>
          {series.map(s => s.values[hover] != null && (
            <span key={s.key} className="t-row"><i style={{ background: s.color }} />{s.label}
              <span className="tv">{yFmt(s.values[hover]!)}{showShare && hoverTotal > 0 && <span className="muted"> · {(s.values[hover]! / hoverTotal * 100).toFixed(1)}%</span>}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

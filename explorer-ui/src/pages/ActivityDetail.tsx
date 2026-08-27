import { useEffect } from 'react'
import { useBlockActivity, useEventAt, useExtrinsic, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect, ACTIVITY_SLUG_TAB, type ActivitySlug } from '../router'
import { activityLabel, canonicalTarget, subordinateActivityTarget, parseId, SLUG_TYPES, ActivityDesc, ChainBadge, ConvictionTag, ExternalAccountPill } from '../components/ActivityTable'
import { LIQ_LABELS } from '../components/activityColors'
import { Crumbs, F, AddrPill, FeeAmount, hasTip, StatusBadge, FinalizedBadge, CallPill, MomentLink, SkeletonRows, VoteSideBadge } from '../components/ui'
import { convictionLabel, voteSideLabel, voteSubjectLabel } from '../utils/voteRows'

export function ActivityDetailPage({ slug, id }: { slug: ActivitySlug; id: string }) {
  const label = activityLabel(slug)
  useDocumentTitle(`${label} ${id}`)
  const ref = parseId(id)
  const { data: rows, isLoading, isError } = useBlockActivity(ref?.height ?? null)
  const row = rows?.find(r =>
    SLUG_TYPES[slug].includes(r.type)
    && (ref!.eventIndex != null ? r.eventIndex === ref!.eventIndex : r.extrinsicIndex === ref!.extrinsicIndex))
  const extId = row?.extrinsicIndex != null ? `${row.blockHeight}-${row.extrinsicIndex}` : null
  const { data: ext } = useExtrinsic(extId)
  const { data: stats } = useStats(!!row)
  const now = useNow()

  // An id can name an event that IS activity but is not activity of its OWN: the
  // transfer legs of a swap are that action's plumbing, and the feed renders
  // only the action. Such an id therefore matches no
  // row, and answering "no transfer found" while titling the page "Transfer" asserts
  // a family the event never belonged to and strands the reader one click from what
  // it is. So resolve the event to its extrinsic and hand over to the activity that
  // owns it. Fetched only on that miss, so the found path costs nothing extra.
  const missedEventId = rows && !row && ref?.eventIndex != null ? `${ref.height}-${ref.eventIndex}` : null
  const { data: missedEvent } = useEventAt(missedEventId)
  const handover = missedEvent ? subordinateActivityTarget(rows ?? [], missedEvent.extrinsicIndex) : null

  // Canonicalize slug and id form once the row is known (replaceState — links
  // survive reclassification, and extrinsic-form ids upgrade to event form).
  useEffect(() => {
    if (!row) return
    const target = canonicalTarget(row, slug, id)
    if (target) redirect(target)
  }, [row, slug, id])

  // Hand a subordinate event over to the activity that owns it.
  useEffect(() => {
    if (row || !handover) return
    redirect(handover)
  }, [row, handover])

  const eventId = row?.eventIndex != null ? `${row.blockHeight}-${row.eventIndex}` : null
  const voteSub = row?.type === 'vote'
    ? [voteSideLabel(row.voteSide), convictionLabel(row.voteConviction),
      row.voteRef ? voteSubjectLabel(row.voteRef, row.voteRefPallet, row.voteRefTitle) : null].filter(Boolean).join(' · ')
    : ''
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity', to: `/activity?tab=${ACTIVITY_SLUG_TAB[slug]}` }, { label: id }]} />
        <div className="page-title">{label} <span className="num">{id}</span>
          {row?.type === 'xcm' && <span className="sub">{row.xcmDir === 'in' ? `in from ${row.fromChain ?? '?'}` : `out to ${row.destChain ?? '?'}`}</span>}
          {row?.type === 'vote' && voteSub && <span className="sub">{voteSub}</span>}
        </div>
      </div>

      {!ref ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Invalid activity id</div>
        : isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>No {label.toLowerCase()} activity found at {id}</div>
        : rows && !row && missedEventId && !missedEvent ? <div className="detail-card"><SkeletonRows /></div>
        : rows && !row && handover ? <div className="detail-card"><SkeletonRows /></div>
        : rows && !row ? (
          <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>
            {/* The event may exist and simply not be an activity of its own (a fee leg,
                a reserve, an internal hop). Naming the requested family here would
                claim it was one, so the copy points at what does exist instead. */}
            {missedEvent
              ? <>Event <span className="mono">{id}</span> is not an activity of its own{missedEvent.extrinsicIndex != null ? <> — see <Link to={paths.extrinsic(`${ref!.height}-${missedEvent.extrinsicIndex}`)} className="hash">its extrinsic</Link></> : null}</>
              : <>No {label.toLowerCase()} activity found at {id}</>}
          </div>
        )
        : isLoading || !row ? <div className="detail-card"><SkeletonRows /></div> : (
          <div className="detail-card"><div className="dl">
            {/* headed: this page states the row's context in its own title and subtitle,
                so the description drops what that already says (see ActivityDesc). */}
            <div className="dt">Activity</div><div className="dd"><ActivityDesc r={row} headed /></div>
            <div className="dt">Value</div><div className="dd mono">{F.usd(row.valueUsd)}</div>
            {row.who && <><div className="dt">Account</div><div className="dd"><AddrPill account={row.who} /></div></>}
            {row.type === 'transfer' && row.to && <><div className="dt">To</div><div className="dd"><AddrPill account={row.to} /></div></>}
            {row.type === 'xcm' && row.xcmDir !== 'in' && row.destChain && <>
              <div className="dt">Destination</div><div className="dd"><ChainBadge chain={row.destChain} />{row.destAccount && <span style={{ marginLeft: 8 }}><ExternalAccountPill account={row.destAccount} /></span>}</div>
            </>}
            {/* Reads the badge's own label map, so this page cannot name an
                action differently from the row that led here. */}
            {row.type === 'liquidity' && <><div className="dt">Action</div><div className="dd">{LIQ_LABELS[row.liqAction ?? ''] ?? LIQ_LABELS.Add}</div></>}
            {row.type === 'vote' && <>
              {/* The subtitle carries these too, but a subtitle is scenery: a reader
                  looking for how hard somebody voted looks down the labelled rows, the
                  way they would for any other fact on the page. Conviction especially,
                  since it is what turns an amount into voting power. */}
              <div className="dt">Vote</div>
              <div className="dd"><VoteSideBadge side={row.voteSide} /><ConvictionTag conviction={row.voteConviction} /></div>
              {row.voteRef && row.voteRefPallet && <>
                <div className="dt">Referendum</div>
                <div className="dd"><Link to={paths.referendum(row.voteRefPallet, row.voteRef)} className="ref-link">Open referendum #{row.voteRef}</Link></div>
              </>}
              {/* A collective (Council / Technical Committee) vote has no referendum
                  page to open: it names a proposal hash, and which committee cast it
                  is the fact that page would have carried. */}
              {row.voteRef && !row.voteRefPallet && <>
                <div className="dt">Motion</div>
                <div className="dd"><span className="mono">{row.voteRef}</span>{row.votePallet && <span className="muted"> · {row.votePallet}</span>}</div>
              </>}
            </>}
            <div className="dt">When</div><div className="dd mono"><MomentLink at={row} now={now} /> <FinalizedBadge finalized={row.blockHeight <= (stats?.finalizedBlock ?? -1)} /></div>
            {extId && <><div className="dt">Extrinsic</div><div className="dd mono"><Link to={paths.extrinsic(extId)} className="hash">{extId}</Link></div></>}
            {eventId && <><div className="dt">Event</div><div className="dd mono"><Link to={paths.event(eventId)} className="hash">{eventId}</Link></div></>}
            {ext && <>
              <div className="dt">Call</div><div className="dd"><CallPill name={ext.callName} /></div>
              <div className="dt">Result</div><div className="dd"><StatusBadge ok={ext.success} /></div>
              {(ext.fee || ext.feePayment) && <><div className="dt">Fee</div><div className="dd mono"><FeeAmount payment={ext.feePayment} nativeRaw={ext.fee} /></div></>}
              {hasTip(ext.feePayment, ext.tip) && <><div className="dt">Tip</div><div className="dd mono"><FeeAmount payment={ext.feePayment} nativeRaw={ext.tip} part="tip" /></div></>}
            </>}
          </div></div>
        )}
    </div>
  )
}

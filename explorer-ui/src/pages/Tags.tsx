import { useTags } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, EmptyRow, TableSkeleton, TagIcon, rowNav } from '../components/ui'

// The one clickable row on the hub: the built-in Hydration directory. Its own
// table lives at /tags/hydration (TagsHydration below).
function HydrationTagsHero({ tagCount }: { tagCount: number }) {
  return (
    <Link to={paths.tagsHydration()} className="acct-head" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="acct-meta">
        <div className="tag">Hydration Tags</div>
        <div className="full"><span className="muted">{tagCount} tag{tagCount === 1 ? '' : 's'} · the built-in directory</span></div>
      </div>
      <span className="muted" aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 22 }}>→</span>
    </Link>
  )
}

// The tag discovery hub. Tags are what a viewer clicks and shares, so this page
// browses the directory rather than editing anything.
export function Tags() {
  useDocumentTitle('Tags')
  const { data: systemTags } = useTags()

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tags' }]} />
        <div className="page-title">Tags</div>
      </div>

      <HydrationTagsHero tagCount={systemTags?.length ?? 0} />
    </div>
  )
}

// The built-in account-tag directory: curated in the backend (account_tags) —
// there is intentionally no in-app create/edit/delete. Moved here from /tags
// (now the discovery hub above) to its own route so a direct link to "the
// tag table" still works.
export function TagsHydration() {
  useDocumentTitle('Hydration Tags')
  const { data, isLoading } = useTags()
  const tags = data ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tags', to: paths.tags() }, { label: 'Hydration' }]} />
        <div className="page-title">Hydration Tags <span className="sub">{tags.length} tags</span></div>
      </div>

      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>
        Tags pool several addresses under one identity (e.g. an exchange's wallets). They are combined into a single row across
        Accounts and Holders, while each member keeps its own account page.
      </div>

      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Tag</th><th className="r">Accounts</th></tr></thead>
          <tbody>
            {isLoading && !data ? <TableSkeleton cols={2} rows={6} /> : !tags.length ? <EmptyRow cols={2}>No tags</EmptyRow> : tags.map(g => (
              <tr key={g.tagId} {...rowNav(paths.tag(g.tagId))}>
                <td data-label="Tag">
                  <Link to={paths.tag(g.tagId)} className="addr-pill" onClick={e => e.stopPropagation()}>
                    <TagIcon icon={g.icon} title={g.name} />
                    <span className="tag" style={{ color: g.color }}>{g.name}</span>
                  </Link>
                </td>
                <td data-label="Accounts" className="r mono">{g.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

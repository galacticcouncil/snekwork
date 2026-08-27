import { useEffect, useRef, useState } from 'react'
import type { Route } from '../router'
import { Link, paths } from '../router'
import { SearchBar } from './SearchBar'
import { useTheme } from '../hooks/useTheme'

// Navigation: direct links plus dropdown groups. A group's trigger navigates
// to its primary page (Chain → Blocks, Assets → Assets) while hovering/focusing
// reveals the rest; `menuItems` orders the dropdown independently of the
// trigger/highlight `items`. Every route is still reachable so deep links /
// bookmarks keep working.
type NavItem = { to: string; label: string; match: Route['name'][] }
type NavGroup = { label: string; items: NavItem[]; menuItems?: NavItem[] }
const IT = {
  activity: { to: paths.activity(), label: 'Activity', match: ['activity'] } as NavItem,
  accounts: { to: paths.accounts(), label: 'Accounts', match: ['accounts', 'account', 'tags', 'tags-basilisk', 'tag'] } as NavItem,
  assets: { to: paths.assets(), label: 'Assets', match: ['assets', 'asset', 'holders'] } as NavItem,
  // Pools live under Liquidity, so a pool highlights there.
  liquidity: { to: paths.liquidity(), label: 'Liquidity', match: ['liquidity', 'pool'] } as NavItem,
  blocks: { to: paths.blocks(), label: 'Blocks', match: ['blocks', 'block'] } as NavItem,
  extrinsics: { to: paths.extrinsics(), label: 'Extrinsics', match: ['extrinsics', 'extrinsic'] } as NavItem,
  events: { to: paths.events(), label: 'Events', match: ['events', 'event'] } as NavItem,
  governance: { to: paths.governance(), label: 'Governance', match: ['governance', 'referendum'] } as NavItem,
}
// Liquidity lives under Assets at every width; the trigger navigates to Assets
// so the menu lists only Liquidity. Governance leads the Chain menu while the
// trigger keeps Blocks.
const ASSETS_GROUP: NavGroup = { label: 'Assets', items: [IT.assets, IT.liquidity], menuItems: [IT.liquidity] }
const CHAIN_GROUP: NavGroup = {
  label: 'Chain',
  items: [IT.blocks, IT.extrinsics, IT.events, IT.governance],
  menuItems: [IT.governance, IT.blocks, IT.extrinsics, IT.events],
}
// The desktop nav in visual order; the drawer keeps every destination flat.
const NAV_ENTRIES: Array<{ kind: 'link'; item: NavItem } | { kind: 'group'; group: NavGroup }> = [
  { kind: 'link', item: IT.activity },
  { kind: 'link', item: IT.accounts },
  { kind: 'group', group: ASSETS_GROUP },
  { kind: 'group', group: CHAIN_GROUP },
]
const DRAWER_LINKS: NavItem[] = [IT.activity, IT.accounts, IT.assets, IT.liquidity]
const DRAWER_GROUPS: NavGroup[] = [CHAIN_GROUP]

function matches(item: NavItem, route: Route): boolean {
  return item.match.includes(route.name)
}

// Sun/moon theme switch — rendered in the topbar on desktop and inside the
// drawer on mobile (≤860px hides the topbar instance).
function ThemeToggle({ onClick }: { onClick: () => void }) {
  return (
    <button className="theme-toggle" onClick={onClick} aria-label="Toggle theme">
      <svg className="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
      <svg className="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
    </button>
  )
}

export function Topbar({ route }: { route: Route }) {
  const { toggle: toggleTheme } = useTheme()
  const isDashboard = route.name === 'dashboard'
  const [drawer, setDrawer] = useState(false)
  const drawerTriggerRef = useRef<HTMLButtonElement>(null)
  // Which desktop dropdown is open (by group label), or null. Driven by JS rather
  // than :hover/:focus-within so only one is ever open, and a click closes it.
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  // Close transient navigation UI after any History API navigation. Route
  // objects are derived values, so subscribing to the same events as the router
  // avoids mirroring them in component state.
  useEffect(() => {
    const closeNavigation = () => {
      setDrawer(false)
      setOpenGroup(null)
    }
    const closeOnDesktopResize = () => {
      if (window.innerWidth > 860) setDrawer(false)
    }
    window.addEventListener('popstate', closeNavigation)
    window.addEventListener('explorer:navigation', closeNavigation)
    window.addEventListener('resize', closeOnDesktopResize)
    return () => {
      window.removeEventListener('popstate', closeNavigation)
      window.removeEventListener('explorer:navigation', closeNavigation)
      window.removeEventListener('resize', closeOnDesktopResize)
    }
  }, [])
  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!drawer) return
    const prev = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDrawer(false)
      drawerTriggerRef.current?.focus()
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [drawer])

  return (
    <>
    <header className={`topbar${isDashboard ? ' topbar-dash' : ''}`}>
      <div className="wrap topbar-inner">
        <Link className="brand" to={paths.dashboard()}>
          {/* Basilisk's mark: the disc with the snake-eye slit cut out of it. */}
          <svg className="logo" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
            <path d="M15.6661 0.111816C18.7648 0.111636 21.7939 1.04333 24.3705 2.78907C26.9471 4.53482 28.9553 7.0162 30.1412 9.91942C31.3271 12.8226 31.6374 16.0173 31.0329 19.0994C30.4284 22.1815 28.9363 25.0125 26.7452 27.2346C24.554 29.4566 21.7624 30.9699 18.7232 31.5829C15.684 32.1959 12.5339 31.8812 9.67106 30.6785C6.80826 29.4759 4.36142 27.4393 2.63998 24.8264C0.918544 22.2135 -0.000177668 19.1415 2.57714e-08 15.9991C2.57714e-08 13.9127 0.405218 11.8468 1.19251 9.91927C1.9798 7.99174 3.13375 6.24035 4.58848 4.76508C6.04321 3.28981 7.77023 2.11957 9.67092 1.32116C11.5716 0.522752 13.6088 0.111816 15.6661 0.111816ZM10.5548 15.9991C10.5548 23.6771 15.6661 29.901 15.6661 29.901C15.6661 29.901 20.7773 23.6771 20.7773 15.9991C20.7773 8.32103 15.6661 2.09806 15.6661 2.09806C15.6661 2.09806 10.5548 8.32194 10.5548 15.9991Z" />
          </svg>
          <span className="wm">Snekwork</span>
          <span className="pr">explorer</span>
        </Link>

        <nav className="nav" aria-label="Primary">
          {NAV_ENTRIES.map(entry => {
            if (entry.kind === 'link') {
              const it = entry.item
              return <Link key={it.to} to={it.to} className={`nav-link${matches(it, route) ? ' active' : ''}`}>{it.label}</Link>
            }
            const { group } = entry
            const active = group.items.some(it => matches(it, route))
            const key = group.label
            return (
              <div
                className={`nav-group${openGroup === key ? ' open' : ''}`}
                key={key}
                onMouseEnter={() => setOpenGroup(key)}
                onMouseLeave={() => setOpenGroup(null)}
                onFocus={() => setOpenGroup(key)}
                onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpenGroup(null) }}
              >
                <Link to={group.items[0].to} className={`nav-trigger${active ? ' active' : ''}`} onClick={() => setOpenGroup(null)}>
                  {group.label}<span className="caret" aria-hidden="true">▾</span>
                </Link>
                <div className="nav-menu">
                  {(group.menuItems ?? group.items).map(it => (
                    <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''} onClick={() => setOpenGroup(null)}>{it.label}</Link>
                  ))}
                </div>
              </div>
            )
          })}
        </nav>

        <div className={`topbar-search ${isDashboard ? 'hidden' : ''}`}>
          {!isDashboard && <SearchBar variant="topbar" />}
        </div>

        <div className="topbar-right">
          <ThemeToggle onClick={toggleTheme} />
          <button ref={drawerTriggerRef} className="nav-burger" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer} aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
        </div>
      </div>
    </header>

      {drawer && (
        <div className="drawer-scrim" onClick={() => setDrawer(false)}>
          <nav className="drawer" role="dialog" aria-modal="true" aria-label="Menu" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <span className="brand">
                <span className="wm">Snekwork</span><span className="pr">explorer</span>
              </span>
              <button className="theme-toggle" onClick={() => setDrawer(false)} aria-label="Close menu">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="drawer-sec">
              <div className="sec-lbl">Explore</div>
              {DRAWER_LINKS.map(it => (
                <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''}>{it.label}</Link>
              ))}
            </div>
            {DRAWER_GROUPS.map(group => (
              <div className="drawer-sec" key={group.label}>
                <div className="sec-lbl">{group.label}</div>
                {(group.menuItems ?? group.items).map(it => (
                  <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''}>{it.label}</Link>
                ))}
              </div>
            ))}
            <div className="drawer-sec drawer-controls">
              <ThemeToggle onClick={toggleTheme} />
            </div>
          </nav>
        </div>
      )}
    </>
  )
}

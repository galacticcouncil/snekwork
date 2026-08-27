import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Accounts } from '../src/pages/Accounts'
import type { TopAccountRow } from '../src/types'

// Finds the single anchor wrapping `text` — a pill's icon + name share one <a>,
// so the href never sits right next to the visible text.
function hrefOf(html: string, text: string): string | undefined {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  return anchors.find(m => m[2].includes(text))?.[1]
}

// A viewer's own tag now folds INSIDE the accounts directory's ranking query,
// exactly like a system tag (see explorerService.getAccountsForViewerFold) —
// A tagged group arrives pre-folded from the server. This confirms that shape
// renders as a TagGroupPill and links to the tag's own aggregate page, next to
// an ordinary account row that isn't affected by it.
describe('Accounts directory — a tag row arrives pre-folded from the server', () => {
  const ACC3 = '0x' + '33'.repeat(32)

  function accountRow(id: string, usd: number): TopAccountRow {
    return {
      account: { accountId: id, address: id, emoji: '🦊', tag: null, identity: null },
      tag: null, portfolioUsd: usd, lastBlock: 100,
    }
  }
  function userTagRow(usd: number): TopAccountRow {
    return {
      account: null,
      tag: { tagId: 't1', name: 'Whales', color: '#22c55e', icon: '🐳', memberCount: 2 },
      portfolioUsd: usd, lastBlock: 100,
    }
  }

  it('renders the folded row as a TagGroupPill linking to its own aggregate page, leaving the plain row alone', () => {
    const rows: TopAccountRow[] = [userTagRow(800_000), accountRow(ACC3, 200_000)]
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['accounts', 0, 50, 'value'], { rows, total: rows.length })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Accounts /></QueryClientProvider>)

    expect(html).toContain('Whales')
    expect(html).toContain('·2')
    expect(hrefOf(html, 'Whales')).toBe('/tag/t1')
    // Two body rows: the folded tag row and the unrelated account — the fold
    // already happened server-side, so there is no third "member" row to drop.
    expect(html.match(/data-label="Account"/g)).toHaveLength(2)
    expect(html).toContain('$800k')
    expect(html).toContain('$200k')
  })
})

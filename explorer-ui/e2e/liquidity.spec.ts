import { expect, test } from './fixtures/test'

// Liquidity surfaces: the asset detail's Liquidity tab and the pool detail
// page, plus their navigation glue.

test('asset Liquidity tab lists sources by value and links to the pool page', async ({ page }) => {
  await page.goto('/asset/5?tab=liquidity')
  const cards = page.locator('.pool-cards .hdx-card')
  await expect(cards.first()).toBeVisible()

  // DOT sits in both mock pairs, and the fixture's largest DOT holding is the
  // vDOT/DOT pair.
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText('vDOT / DOT')
  // Former pools render with their last-active moment.
  await expect(page.locator('table.tbl tr', { hasText: 'DOT / GLMR' })).toBeVisible()
  // History chart present with its unit toggle.
  await expect(page.locator('.liq-toggle')).toBeVisible()

  await page.locator('.pool-cards .hdx-card', { hasText: 'vDOT / DOT' }).click()
  await expect(page).toHaveURL(/\/pool\/690$/)
})

test('the Liquidity tab chip counts the asset\'s current pools', async ({ page }) => {
  await page.goto('/asset/5')
  await expect(page.locator('.tabs button', { hasText: 'Liquidity' }).locator('.cnt')).toHaveText('2')
})

test('pool detail shows the pool card, its composition and its LPs', async ({ page }) => {
  await page.goto('/pool/690')
  await expect(page.locator('.page-title')).toContainText('vDOT / DOT')

  // Detail card facts: venue, fee, share token, LP supply.
  await expect(page.locator('.detail-card')).toContainText('Trade fee')
  await expect(page.locator('.detail-card')).toContainText('Share token')
  await expect(page.locator('.detail-card')).toContainText('LP supply')

  // Composition rows navigate to the asset pages.
  await expect(page.locator('table.tbl tr', { hasText: 'vDOT' }).first()).toBeVisible()
  await expect(page.locator('.sec-title', { hasText: 'Liquidity providers' })).toBeVisible()
})

test('a second pool renders the same way, and an unknown pool 404s', async ({ page }) => {
  await page.goto('/pool/1000194')
  await expect(page.locator('.page-title')).toContainText('HDX / DOT')
  await expect(page.locator('.detail-card')).toContainText('Trade fee')

  await page.goto('/pool/424242')
  await expect(page.getByText('Pool not found')).toBeVisible()
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const path of ['/asset/5?tab=liquidity', '/pool/690']) {
    test(`no horizontal overflow at 390px on ${path}`, async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('.detail-card, .pool-cards .hdx-card').first()).toBeVisible()
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement!
        return el.scrollWidth - el.clientWidth
      })
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }
})

// A pool page must show what traded IN the pool. Everywhere else a routed swap
// is collapsed into its net Router.Executed row, whose legs name neither the
// pool's members nor its share token — so asking the share token for its
// activity (what this page used to do) showed liquidity and share trades while
// the pool's own swaps, the reason to visit a pool page, appeared nowhere.
// Reported against /pool/690, whose recent vDOT/DOT swaps were all missing.
test('a pool page shows the swaps that happened in the pool', async ({ page }) => {
  await page.goto('/pool/690')
  const rows = page.locator('table.tbl tbody tr')
  await expect(rows.first()).toBeVisible()

  // Both legs of at least one row are pool members, which is what a swap
  // through this pool looks like — a share-token trade never is.
  const memberPairs = await rows.evaluateAll(trs => trs.filter(tr => {
    const t = tr.querySelector('td[data-label="Activity"]')?.textContent ?? ''
    return /vDOT/.test(t) && /DOT/.test(t) && !/GDOT/.test(t)
  }).length)
  expect(memberPairs).toBeGreaterThan(0)
})

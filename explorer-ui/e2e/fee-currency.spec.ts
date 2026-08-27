import { expect, test } from './fixtures/test'

// A fee is charged in the signer's nominated fee currency, so for roughly a fifth
// of extrinsics the BSX figure the chain computes names an asset that never left
// the account. Every surface that states a fee has to state the asset it was
// actually debited in — and must not print the BSX number beside it, which would
// read as a second charge.

const feeRow = (page: import('@playwright/test').Page, label: RegExp) =>
  page.locator('.detail-card').first().locator('.dt', { hasText: label }).locator('xpath=following-sibling::*[1]')

test('an extrinsic that paid in DOT states DOT, not BSX', async ({ page }) => {
  await page.goto('/extrinsic/12848613-3')

  const fee = feeRow(page, /^Fee$/)
  await expect(fee.locator('.asset-chip')).toContainText('DOT')
  await expect(fee).not.toContainText('BSX')
  // The rounded figure is the visible one; the exact debit stays on the title, so
  // a fee small enough to round away is still recoverable.
  await expect(fee.locator('[title]').first()).toHaveAttribute('title', /DOT$/)

  // The tip belongs to the same charge and so to the same asset — the runtime
  // converts both through one price and deposits them as one amount.
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('DOT')
})

test('an BSX-paying extrinsic reads in the same shape', async ({ page }) => {
  await page.goto('/extrinsic/12848613-2')

  // Same icon-ticker-amount convention as every other asset, so the fee row does
  // not change shape depending on which currency paid it.
  const fee = feeRow(page, /^Fee$/)
  await expect(fee.locator('.asset-chip')).toContainText('BSX')
  await expect(fee.locator('[title]').first()).toHaveAttribute('title', /BSX$/)
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('BSX')
})

test('a curated surface shows the tip beside the fee, and only when there is one', async ({ page }) => {
  // A swap states the tip beside the fee, in whichever asset the charge settled
  // in — here BSX, from the trade's own tip figure.
  await page.goto('/swap/12848613-4')
  await expect(feeRow(page, /^Fee$/).locator('.asset-chip')).toContainText('BSX')
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('BSX')

  // And a nominated-currency payer tips in that currency: one deposit split into
  // the two rows, never one row in BSX beside the other in USDT.
  await page.goto('/extrinsic/12848613-4')
  await expect(feeRow(page, /^Fee$/).locator('.asset-chip')).toContainText('USDT')
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('USDT')
})

test('the extrinsic hover card and the raw JSON carry the paid asset too', async ({ page }) => {
  await page.goto('/extrinsics')

  await page.locator('a[href="/extrinsic/12848613-3"]').first().hover()
  const card = page.locator('.hovercard')
  await expect(card).toContainText('DOT')
  // 12848613-3 does not tip, so the card spends no line saying so — the predicate
  // that adds the row is the same one the detail surfaces use.
  await expect(card.locator('.hc-row', { hasText: /^Fee/ })).toHaveCount(1)
  await expect(card.locator('.hc-row', { hasText: /^Tip/ })).toHaveCount(0)

  await page.goto('/extrinsic/12848613-3')
  await page.locator('.tabs button', { hasText: 'Raw JSON' }).click()
  const json = page.locator('div.json').first()
  await expect(json).toContainText('fee_asset')
  await expect(json).toContainText('DOT')
  // The BSX-equivalent the chain reported stays in the payload beside it: the two
  // are different facts, and only the display picks one.
  await expect(json).toContainText('fee_paid')
})

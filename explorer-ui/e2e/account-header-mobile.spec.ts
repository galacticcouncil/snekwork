import { expect, test } from './fixtures/test'

// Mobile account header: the identity block (inline emoji + name + address)
// takes the first row on its own, and every stat — the trading volume, then
// the account value — shares ONE line below it, clustered right with the value
// last and largest.
test.use({ viewport: { width: 390, height: 844 } })

const FOX = 'bXkSQSxKBexhk3Y6Ah3MN481hsjta9Uars3MoXufiNViLy3Xo'

test('the identity keeps its own row; every stat shares one line below', async ({ page }) => {
  await page.goto(`/account/${FOX}`)
  const avatar = page.locator('.acct-avatar')
  await expect(avatar).toBeVisible()

  const value = page.locator('.acct-stats .acct-bal:not(.subtle)')
  const a = (await avatar.boundingBox())!
  const v = (await value.boundingBox())!

  // The stats line is its own row: nothing in it reaches back up into the
  // identity block, so a long name can never collide with the value.
  expect(v.y, 'value should start below the identity').toBeGreaterThan(a.y + a.height)
  // Right-aligned: the value block ends in the right half of the 390px viewport.
  expect(v.x + v.width).toBeGreaterThan(300)

  // The trading volume sits on that same line, left of the value — the whole
  // group top-aligned so the labels read as one row.
  const addr = (await page.locator('.acct-meta .full').boundingBox())!
  const volumes = page.locator('.acct-stats .acct-bal.subtle')
  await expect(volumes).toHaveCount(1)
  const b0 = (await volumes.nth(0).boundingBox())!
  expect(b0.y, 'volume below the address').toBeGreaterThan(addr.y + addr.height - 2)
  expect(Math.abs(b0.y - v.y), 'value on that same line').toBeLessThan(2)
  expect(b0.x + b0.width, 'value last in the group').toBeLessThanOrEqual(v.x)

  // The header must not widen the page.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

// EVM accounts: no "EVM" badge in the header address line — it forced the
// short address to wrap mid-token on phones, and the 0x prefix (plus the
// identities card's "EVM (H160)" row) already says it.
test('EVM account header shows the address on one unbroken line', async ({ page }) => {
  await page.goto('/account/0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad')
  const full = page.locator('.acct-meta .full')
  await expect(full).toBeVisible()
  await expect(full.locator('.id-kind')).toHaveCount(0)
  const box = (await full.boundingBox())!
  expect(box.height, 'address must not wrap').toBeLessThan(26)
})

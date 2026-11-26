import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { makeDecision } from '../src/choices'
import { ruleDetails } from '../src/contracts'
import { type Bulletin, type Profile } from '../src/domain'
import { decisionContext } from '../src/explanationFacts'
import { screenshot } from './screenshot'

const at = (time: string) => Date.parse('2026-11-24T' + time + '+05:30')
const family: Profile = {
  people: 'With children', activity: 'Playtime', period: 'Afternoon', travel: 'Work from home',
}
const forecast = [
  ['12:30', 80], ['13:30', 75], ['14:30', 70], ['15:30', 65], ['16:30', 60],
] as const
const bulletin: Bulletin = {
  city: 'delhi', valid: at('11:30:00'), retrieved: at('12:25:00'),
  aqi: 352, pm25: null, pm10: null,
  hours: forecast.map(([time, aqi]) => ({ time: at(time + ':00'), aqi })),
}

async function openBulletin(page: Page, now: number, data: Bulletin) {
  const requests = { air: 0, browserRevisions: [] as string[], workerRevisions: [] as string[] }
  await page.clock.install({ time: now - 60_000 })
  await page.clock.pauseAt(now)
  await page.addInitScript(profile => localStorage.setItem('hawa.v1.profile', JSON.stringify(profile)), family)
  await page.route('**/api/air?*', route => {
    requests.air++
    return route.fulfill({ json: data })
  })
  await page.route('**/api/explain', async route => {
    const { profile, revision } = route.request().postDataJSON()
    const workerTime = await page.evaluate(() => Date.now())
    // Rebuild the rules envelope from source facts at the simulated Worker time.
    const decision = makeDecision(data, profile, workerTime)
    const context = decisionContext(data, profile, decision, workerTime)
    const detail = workerTime < at('12:30:00') ? ruleDetails.single : ruleDetails.current
    requests.browserRevisions.push(revision)
    requests.workerRevisions.push(createHash('sha256').update(context).digest('hex'))
    await route.fulfill({ json: { mode: 'rules', reasoning: null, created: workerTime, detail, context } })
  })
  await page.goto('/')
  await expect(page.getByTestId('aqi')).toHaveText('352')
  return requests
}

test('one open bulletin retires the hazardous current reading and outdoor choices at exactly one hour', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  const start = at('12:29:59')
  const requests = await openBulletin(page, start, bulletin)
  const banner = page.locator('.conditions')
  const label = banner.locator('.category .band-label')
  const row = page.locator('.timeline li').first()
  const title = row.getByRole('heading')
  const result = page.locator('.explanation-body')
  const explainButton = page.getByRole('button', { name: 'Explain my plan' })
  const width = page.viewportSize()!.width
  await expect(label).toHaveText(/current/i)
  await expect(banner.getByRole('heading')).toHaveText('Hazardous')
  await expect(row).toContainText(/afternoon.*today.*now/is)
  await expect(title).toContainText(/move playtime indoors/i)
  await expect(row).toContainText(/current.*352.*hazardous/i)
  await screenshot(page, 'repaired-' + width + '-122959')
  await explainButton.focus()
  await page.keyboard.press('Enter')
  await expect(result).toContainText(/move playtime indoors/i)
  await expect(result).toContainText(/current.*352.*hazardous/i)

  // Advance the application's scheduled timers without reloading or fetching.
  await page.clock.runFor(999)
  await expect(label).toHaveText(/current/i)
  await expect(result).toBeVisible()
  await page.clock.runFor(1)
  await expect(label).toHaveText(/earlier.*modeled.*reading/i)
  await expect(banner).toContainText(/current.*(?:unavailable|missing|unknown)|no current/i)
  await expect(banner).not.toHaveAccessibleName(/^Current conditions$/i)
  await expect(banner.getByRole('heading')).toHaveText('Hazardous')
  await expect(banner).toContainText('11:30 IST')
  await expect(title).toContainText(/recheck|check/i)
  await expect(row).toContainText(/current.*(?:unavailable|missing|unknown)|no current/i)
  await expect(row).toContainText(/earlier.*11:30 IST.*352.*hazardous/i)
  await expect(row).toContainText(/forecast.*60–80|60–80.*forecast/i)
  const unsupportedAdvice = /build breaks into playtime|keeping playtime outdoors|current (?:modeled )?US AQI is 352|currently hazardous/i
  await expect(row).not.toContainText(unsupportedAdvice)
  await expect(result).toHaveCount(0)
  await page.clock.runFor(1_000)
  expect(await page.evaluate(() => Date.now())).toBe(at('12:30:01'))
  await expect(label).toHaveText(/earlier.*modeled.*reading/i)
  await expect(title).toContainText(/recheck|check/i)
  expect(requests.air).toBe(1)
  expect(requests.browserRevisions).toHaveLength(1)
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(label).toBeInViewport()
  await expect(banner.getByText(/current.*(?:unavailable|missing|unknown)|no current/i).last()).toBeInViewport()
  await screenshot(page, 'repaired-' + width + '-123001')
  await row.evaluate(el => el.scrollIntoView({ block: 'start' }))
  await expect(title).toBeInViewport()
  await screenshot(page, 'repaired-' + width + '-action')

  const source = page.getByRole('button', { name: 'Source details' })
  await source.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/valid time.*11:30 IST.*retrieved.*12:25 IST/is)
  await page.keyboard.press('Escape')
  await expect(source).toBeFocused()

  const outlook = page.locator('#forecast')
  await expect(outlook.locator('.plot')).toBeVisible()
  await expect(outlook.locator('.chart-note')).toContainText(/current.*(?:unavailable|missing|unknown)|no current/i)
  await outlook.getByText('View hourly values', { exact: true }).focus()
  await page.keyboard.press('Enter')
  const table = outlook.getByRole('table')
  await expect(table).toContainText(/regional forecast.*modeled for its timestamp/is)
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(forecast.length)
  await expect(rows.first()).toContainText(/earlier forecast/i)
  for (const [i, [time, aqi]] of forecast.entries()) {
    await expect(rows.nth(i)).toContainText(time)
    await expect(rows.nth(i).getByRole('cell').last()).toHaveText(String(aqi))
  }
  await outlook.evaluate(el => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, 'repaired-' + width + '-hourly')

  await explainButton.focus()
  await page.keyboard.press('Enter')
  await expect(result.getByRole('heading')).toHaveText('Rule-based explanation')
  await expect(result.locator('dd strong').first()).toHaveText(await title.innerText())
  await expect(result).toContainText(/current.*(?:unavailable|missing|unknown)|no current/i)
  await expect(result).not.toContainText(unsupportedAdvice)
  await expect(result).not.toContainText(/alternative|conditions changed|could not be verified|service is unavailable/i)
  expect(requests.browserRevisions).toEqual(requests.workerRevisions)
  expect(new Set(requests.browserRevisions).size).toBe(2)
  expect(requests.air).toBe(1)
  await result.evaluate(el => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, 'repaired-' + width + '-explanation')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])

  // Axe uses browser timers. Let time advance during the accessibility scan.
  await page.clock.resume()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})

test('source validity expires after three hours even with a recent provider retrieval', async ({ page }) => {
  const now = at('14:29:59')
  const requests = await openBulletin(page, now, { ...bulletin, retrieved: at('14:25:00') })
  const banner = page.locator('.conditions')
  const plot = page.locator('#forecast .plot')
  const row = page.locator('.timeline li').first()
  await expect(banner).toContainText(/earlier.*modeled.*reading/i)
  await expect(plot).toBeVisible()
  await expect(row.getByRole('heading')).toContainText(/recheck|check/i)
  await page.clock.runFor(1_000)
  await expect(plot).toBeVisible()
  await expect(banner).not.toContainText(/stale estimate/i)
  await page.clock.runFor(1)
  await expect(plot).toHaveCount(0)
  await expect(banner.locator('.condition-state')).toContainText(/stale/i)
  await expect(banner).toContainText('11:30 IST')
  await expect(page.getByTestId('aqi')).toHaveText('352')
  await expect(page.locator('.chart-note')).toContainText(/fresh hourly forecast is needed/i)
  await expect(row.getByRole('heading')).toContainText(/recheck|check/i)
  await expect(row).not.toContainText(/build breaks|current (?:modeled )?US AQI is 352/i)
  expect(requests.air).toBe(1)
})

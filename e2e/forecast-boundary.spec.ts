import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { makeDecision } from '../src/choices'
import { ruleDetails } from '../src/contracts'
import type { Bulletin, Profile } from '../src/domain'
import { decisionContext } from '../src/explanationFacts'
import { screenshot } from './screenshot'

const at = (time: string) => Date.parse('2026-11-24T' + time + ':00+05:30')
const noonCheck = at('12:05')
const family: Profile = {
  people: 'With children', activity: 'Playtime', period: 'Afternoon', travel: 'Work from home',
}

test('12:05 playtime distinguishes the earlier hazardous forecast, later moderate samples and a current reading', async ({ page }) => {
  // Expected values are the six timestamped inputs from the independent audit.
  const times = ['11:30', '12:30', '13:30', '14:30', '15:30', '16:30']
  const values = [352, 80, 75, 70, 65, 60]
  const hours = times.map((time, i) => ({ time: at(time), aqi: values[i] }))
  let bulletin: Bulletin = {
    city: 'delhi', valid: noonCheck, retrieved: noonCheck, aqi: null, pm25: null, pm10: null,
    hours,
  }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  await page.clock.setFixedTime(noonCheck)
  await page.addInitScript(profile => localStorage.setItem('hawa.v1.profile', JSON.stringify(profile)), family)
  await page.route('**/api/air?*', route => route.fulfill({ json: bulletin }))
  const revisions: string[] = []
  const sourceRevisions: string[] = []
  await page.route('**/api/explain', async route => {
    // Supply only the rules envelope. The browser resolves all the action text.
    const { revision, profile } = route.request().postDataJSON()
    const context = decisionContext(bulletin, profile, makeDecision(bulletin, profile, noonCheck), noonCheck)
    revisions.push(revision)
    sourceRevisions.push(createHash('sha256').update(context).digest('hex'))
    await route.fulfill({ json: {
      mode: 'rules', reasoning: null, detail: ruleDetails.current, created: noonCheck, context,
    } })
  })

  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page).toHaveTitle(/HawaPlan/)
  await expect(page.getByRole('heading', { name: 'AQI unavailable' })).toBeVisible()
  const row = page.locator('.timeline li').first()
  const action = row.getByRole('heading')
  await expect(row).toContainText(/afternoon.*today.*now/is)
  await expect(action).toContainText(/indoor/i)
  await expect(action).not.toContainText(/build breaks/i)
  await expect(row).toContainText('11:30')
  await expect(row).toContainText('352')
  await expect(row).toContainText('12:30')
  await expect(row).toContainText(/60–80/)
  await expect(row).toContainText(/current.*(unavailable|missing|unknown)|no current/i)
  const currentHazardClaim = /current (?:modeled )?US AQI is 352|currently hazardous|hazardous (?:now|at present)/i
  await expect(row).not.toContainText(currentHazardClaim)
  const width = page.viewportSize()!.width
  await expect(action).toBeInViewport()
  await screenshot(page, 'after-' + width + '-noon')
  if (width < 400) {
    await row.evaluate(el => el.scrollIntoView({ block: 'start' }))
    await screenshot(page, 'after-' + width + '-action')
  }

  const outlook = page.locator('#forecast')
  await expect(outlook.getByRole('img')).toBeVisible()
  const plot = outlook.locator('.plot')
  await expect(plot).toContainText('11:30')
  // Probe the rendered stroke halfway between the 11:30 and 12:30 dots.
  // Connecting those dots would depict a made-up AQI around the outing time.
  const connectsEarlierToLater = await plot.evaluate(svg => {
    const [earlier, later] = svg.querySelectorAll('circle')
    const midpoint = new DOMPoint(
      (earlier.cx.baseVal.value + later.cx.baseVal.value) / 2,
      (earlier.cy.baseVal.value + later.cy.baseVal.value) / 2,
    )
    return Array.from(svg.querySelectorAll('path')).some(path => path.isPointInStroke(midpoint))
  })
  expect(connectsEarlierToLater).toBe(false)
  await expect(outlook.locator('.chart-note')).toContainText(/11:30/)
  const toggle = outlook.getByText('View hourly values', { exact: true })
  await toggle.focus()
  await page.keyboard.press('Enter')
  const tableRows = outlook.getByRole('table').locator('tbody tr')
  await expect(tableRows).toHaveCount(times.length)
  await expect(tableRows.first()).toContainText(/earlier forecast/i)
  for (const [i, time] of times.entries()) {
    await expect(tableRows.nth(i)).toContainText(time)
    await expect(tableRows.nth(i).getByRole('cell').last()).toHaveText(String(values[i]))
  }
  await outlook.evaluate(el => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, 'after-' + width + '-hourly')

  const request = page.getByRole('button', { name: 'Explain my plan' })
  await request.focus()
  await page.keyboard.press('Enter')
  const result = page.locator('.explanation-body')
  await expect(result.getByRole('heading', { name: 'Rule-based explanation' })).toBeVisible()
  await expect(result).toContainText('11:30')
  await expect(result).toContainText('352')
  await expect(result).not.toContainText(/build breaks/i)
  await expect(result).not.toContainText(currentHazardClaim)
  await expect(result.getByText('Alternative', { exact: true })).toHaveCount(0)
  await expect(result.getByText(/could not be verified|service is unavailable|conditions changed/i)).toHaveCount(0)
  await result.evaluate(el => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, 'after-' + width + '-explanation')
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])

  // A source correction with identical timestamps removes the earlier hazard.
  // Future 60–80 forecasts alone still cannot support outdoor play at 12:05.
  bulletin = { ...bulletin, hours: bulletin.hours.slice(1) }
  async function refresh() {
    await page.getByRole('button', { name: 'Source details' }).click()
    await page.getByRole('button', { name: 'Refresh conditions' }).click()
  }
  await refresh()
  await expect(result).toHaveCount(0)
  await expect(action).toContainText(/recheck|check/i)
  await expect(row).not.toContainText(/build breaks|352/i)
  await expect(tableRows.first()).toContainText('12:30')
  await request.click()
  await expect(result.getByRole('heading', { name: 'Rule-based explanation' })).toBeVisible()
  await expect(result).not.toContainText(/build breaks|352/i)
  await expect(result.getByText('Alternative', { exact: true })).toHaveCount(0)
  expect(revisions).toHaveLength(2)
  expect(revisions).toEqual(sourceRevisions)
  expect(revisions[1]).not.toBe(revisions[0])

  // A current modeled value of 352 is independent evidence for indoor play.
  bulletin = { ...bulletin, aqi: 352 }
  await refresh()
  await expect(result).toHaveCount(0)
  await expect(page.getByTestId('aqi')).toHaveText('352')
  await expect(action).toContainText(/playtime indoors/i)
  await expect(row).toContainText(/current.*352.*hazardous/is)

  // At the next exact forecast timestamp, the 11:30 value is a full sample old.
  await page.clock.setFixedTime(at('12:30'))
  bulletin = { ...bulletin, aqi: null, hours }
  await refresh()
  await expect(tableRows.first()).toContainText('12:30')
  await expect(row).not.toContainText(/352|hazardous/i)
  await expect(row).toContainText(/60–80/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
})

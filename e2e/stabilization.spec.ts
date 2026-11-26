import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { makeDecision } from '../src/choices'
import { modelDetail, ruleDetails } from '../src/contracts'
import { defaults, hour, type Bulletin } from '../src/domain'
import { decisionContext } from '../src/explanationFacts'
import { screenshot } from './screenshot'

const morning = Date.parse('2026-11-24T08:30:00+05:30')
const first = Date.parse('2026-11-24T00:30:00+05:30')
function bulletin(now = morning): Bulletin {
  return {
    city: 'delhi', valid: now, retrieved: now, aqi: 55, pm25: 42, pm10: 63,
    hours: Array.from({ length: 48 }, (_, i) => ({ time: first + i * hour, aqi: 55 })),
  }
}
async function setClock(page: Page, now: number) {
  await page.clock.install({ time: now - 1_000 })
  await page.clock.pauseAt(now)
}
async function refresh(page: Page) {
  await page.getByRole('button', { name: 'Source details' }).click()
  await page.getByRole('button', { name: 'Refresh conditions' }).click()
}
async function mockModel(page: Page, data: Bulletin, now: number) {
  let requests = 0
  await page.route('**/api/explain', async (route) => {
    requests++
    const profile = route.request().postDataJSON().profile
    await route.fulfill({ json: {
      mode: 'model', created: now, detail: modelDetail,
      context: decisionContext(data, profile, makeDecision(data, profile, now), now),
      reasoning: {
        prefer: { option: 'selected-outing', goals: ['keeps-outdoor-activity'] },
        switchIf: { option: 'indoor', goal: 'indoor-activity' },
        cost: 'depends-on-local-conditions',
        limit: { option: 'selected-outing', fact: 'regional-forecast' },
      },
    } })
  })
  return () => requests
}
const explain = (page: Page) => page.getByRole('button', { name: 'Explain my plan' })
const model = (page: Page) => page.getByRole('heading', { name: 'AI-composed explanation' })
const current = (page: Page) => page.getByText('Modeled estimate', { exact: true })

test('discards an unordered saved bulletin and caches a valid forecast on retry', async ({ page }) => {
  await setClock(page, morning)
  const fresh = {
    ...bulletin(),
    hours: [
      { time: morning, aqi: 55 },
      { time: morning + hour, aqi: null },
      { time: morning + 3 * hour, aqi: 80 },
    ],
  }
  const key = 'hawa.v1.air.delhi'
  const corrupt = { ...fresh, aqi: 355, hours: [...fresh.hours].reverse() }
  await page.addInitScript(({ key, corrupt }) => {
    localStorage.setItem(key, JSON.stringify(corrupt))
  }, { key, corrupt })
  let available = false
  await page.route('**/api/air?*', route => available
    ? route.fulfill({ json: fresh })
    : route.fulfill({ status: 503, json: { error: 'source' } }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'No current reading' })).toBeVisible()
  await expect(page.getByTestId('aqi')).toHaveText('—')
  await expect(page.locator('#forecast .plot')).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull()

  available = true
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(current(page)).toBeVisible()
  await expect(page.getByTestId('aqi')).toHaveText('55')
  await page.getByText('View hourly values', { exact: true }).click()
  const rows = page.getByRole('table').locator('tbody tr')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(1)).toContainText(/09:30.*Unavailable/)
  await expect(rows.last()).toContainText(/11:30.*80/)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(fresh)
})

test('identical and retrieval-only refreshes retain the plot and open model explanation without repeat requests', async ({ page }, info) => {
  await setClock(page, morning)
  // Current evidence survives even when private browsing disallows persistence.
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'SecurityError') }
  })
  const data = bulletin()
  const modelRequests = await mockModel(page, data, morning)
  let pending = Promise.resolve()
  let retrieval = data.retrieved
  let airRequests = 0
  await page.route('**/api/air?*', async route => {
    airRequests++
    await pending
    await route.fulfill({ json: { ...data, retrieved: retrieval } })
  })
  await page.goto('/')
  await expect(current(page)).toBeVisible()
  await explain(page).click()
  await expect(model(page)).toBeVisible()
  const before = await page.locator('.explanation-body').innerText()
  const plot = page.locator('#forecast .plot')
  const path = await plot.locator('path.line').getAttribute('d')

  let finish!: () => void
  pending = new Promise<void>(resolve => { finish = resolve })
  await refresh(page)
  await expect(page.locator('.condition-state')).toContainText(/refresh/i)
  await expect(page.locator('.conditions')).not.toContainText(/stale/i)
  await refresh(page)
  await expect(page.locator('.condition-state')).toContainText(/refresh/i)
  await expect(plot.locator('path.line')).toHaveAttribute('d', path!)
  await expect(model(page)).toBeVisible()
  await expect(page.locator('.explanation-body')).toHaveText(before, { useInnerText: true })
  await page.evaluate(() => scrollTo(0, 0))
  if (info.project.name === 'desktop') await screenshot(page, 'after-refresh-pending')
  finish()
  await expect(current(page)).toBeVisible()
  await expect(model(page)).toBeVisible()
  expect(airRequests).toBe(2)

  // Same measurements and forecasts, with a newly recorded provider check.
  await page.clock.fastForward(60_000)
  retrieval += 60_000
  const response = page.waitForResponse('**/api/air?*')
  await refresh(page)
  expect((await (await response).json()).retrieved).toBe(retrieval)
  await expect(current(page)).toBeVisible()
  await expect(page.locator('.explanation-body')).toHaveText(before, { useInnerText: true })
  await page.getByRole('button', { name: 'Hide explanation' }).click()
  await expect(model(page)).toBeHidden()
  await page.getByRole('button', { name: 'Show explanation' }).click()
  await expect(model(page)).toBeVisible()
  await page.getByRole('button', { name: 'Household', exact: true }).click()
  await page.getByRole('button', { name: 'Save household' }).click()
  await expect(model(page)).toBeVisible()
  expect(modelRequests()).toBe(1)
  await page.getByRole('button', { name: 'Household', exact: true }).click()
  await page.getByLabel('Usual travel').selectOption('Walk or cycle')
  await page.getByRole('button', { name: 'Save household' }).click()
  await expect(model(page)).toHaveCount(0)
  await expect(explain(page)).toBeVisible()
  expect(modelRequests()).toBe(1)
})

test('revised source validity and same-timestamp hourly forecasts invalidate the old comparison', async ({ page }) => {
  await setClock(page, morning)
  let data = bulletin()
  await page.route('**/api/air?*', route => route.fulfill({ json: data }))
  await page.route('**/api/explain', route => route.fulfill({ json: {
    mode: 'rules', created: morning, detail: ruleDetails.binding, reasoning: null,
    context: decisionContext(data, defaults, makeDecision(data, defaults, morning), morning),
  } }))
  await page.goto('/')
  const box = page.locator('.explanation-body')
  await expect(current(page)).toBeVisible()
  await explain(page).click()
  await expect(box).toContainText('55 US AQI')
  data = { ...data, valid: data.valid - 30 * 60_000 }
  await refresh(page)
  await expect(page.locator('.provenance')).toContainText('08:00 IST')
  await expect(box).toHaveCount(0)
  await explain(page).click()
  await expect(box).toContainText('Moderate')
  data = { ...data, hours: data.hours.map(p => ({ ...p, aqi: 355 })) }
  await refresh(page)
  await expect(page.locator('.timeline li').first()).toContainText(/hazardous/i)
  await expect(box).toHaveCount(0)
  await explain(page).click()
  await expect(box).toContainText(/355 US AQI.*hazardous/i)
  await expect(box).not.toContainText(/55 US AQI \(Moderate/)
})

test('evidence expires during revalidation and an expired reply cannot restore its plan', async ({ page }) => {
  const now = Date.parse('2026-11-24T08:30:58+05:30')
  await setClock(page, now)
  const data = { ...bulletin(now), retrieved: now - hour + 1_500 }
  const modelRequests = await mockModel(page, data, now)
  let hold = Promise.resolve()
  await page.route('**/api/air?*', async route => {
    await hold
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await expect(current(page)).toBeVisible()
  await explain(page).click()
  await expect(model(page)).toBeVisible()
  let finish!: () => void
  hold = new Promise<void>(resolve => { finish = resolve })
  await refresh(page)
  await expect(page.locator('.condition-state')).toContainText(/refresh/i)
  await page.clock.fastForward(3_000)
  const status = page.locator('.condition-state')
  await expect(status).toContainText(/stale/i)
  await expect(page.locator('#forecast .plot')).toHaveCount(0)
  await expect(model(page)).toHaveCount(0)
  await expect(page.locator('.timeline li').first()).toContainText(/recheck/i)
  const reply = page.waitForResponse('**/api/air?*')
  finish()
  await reply
  await expect(status).toContainText(/stale/i)
  await expect(page.getByTestId('aqi')).toHaveText('55')
  await expect(page.locator('#forecast .plot')).toHaveCount(0)
  expect(modelRequests()).toBe(1)
})

test('crossing noon in an open bulletin retires the previous morning decision', async ({ page }) => {
  const now = Date.parse('2026-11-24T11:59:58+05:30')
  const data = bulletin(now)
  await setClock(page, now)
  await page.route('**/api/air?*', route => route.fulfill({ json: data }))
  await page.route('**/api/explain', route => route.fulfill({ json: {
    mode: 'rules', detail: ruleDetails.single, created: now, reasoning: null,
    context: decisionContext(data, defaults, makeDecision(data, defaults, now), now),
  } }))
  await page.goto('/')
  await expect(current(page)).toBeVisible()
  await explain(page).click()
  await expect(page.locator('.explanation-body')).toContainText(/morning.*24 Nov/i)
  await page.clock.fastForward(4_000)
  const rows = page.locator('.timeline li')
  await expect(rows.first()).toContainText(/afternoon.*today/is)
  await expect(rows.last()).toContainText(/morning.*tomorrow/is)
  await expect(page.locator('.explanation-body')).toHaveCount(0)
  await expect(explain(page)).toBeVisible()
})

test('a Worker evidence conflict rechecks source data before presenting the revised plan', async ({ page }) => {
  const data = bulletin()
  let revised = false
  let airRequests = 0
  let explanations = 0
  await setClock(page, morning)
  await page.route('**/api/air?*', route => {
    airRequests++
    return route.fulfill({ json: revised ? { ...data, hours: data.hours.map(p => ({ ...p, aqi: 355 })) } : data })
  })
  await page.route('**/api/explain', route => {
    explanations++
    revised = true
    return route.fulfill({ status: 409, json: { error: 'changed' } })
  })
  await page.goto('/')
  await expect(current(page)).toBeVisible()
  await explain(page).click()
  await expect(page.locator('.timeline li').first()).toContainText(/hazardous/i)
  await expect(page.locator('.explanation-body')).toHaveCount(0)
  expect(airRequests).toBe(2)
  expect(explanations).toBe(1)
})

test('bulletin links, disclosure, source readings and the midnight marker work at the requested widths', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  const width = page.viewportSize()!.width
  const data = { ...bulletin(), aqi: 155 }
  data.hours = data.hours.map((p, index) => ({ ...p, aqi: index % 2 ? 155 : 153.25 }))
  await page.clock.setFixedTime(morning)
  await page.route('**/api/air?*', route => route.fulfill({ json: data }))
  await page.route('**/api/explain', route => route.fulfill({ json: {
    mode: 'rules', created: morning, detail: ruleDetails.single, reasoning: null,
    context: decisionContext(data, defaults, makeDecision(data, defaults, morning), morning),
  } }))
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page).toHaveTitle(/HawaPlan/)
  await expect(page.getByRole('heading', { name: 'Delhi' })).toBeVisible()
  await expect(page.getByTestId('aqi')).toHaveText('155')
  await expect(page.locator('.provenance')).toContainText(/Open-Meteo.*CAMS.*08:30 IST/i)
  const assertWidth = async () => {
    // On Chrome mobile an overflowing page inflates innerWidth to match its
    // contents. Use the configured CSS viewport, including when scrolled.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  }
  await assertWidth()
  await screenshot(page, 'after-' + width)
  await page.getByRole('button', { name: 'Source details' }).click()
  const source = page.getByRole('dialog')
  await expect(source).toContainText(/modeled estimate and hourly forecast/i)
  await expect(source).toContainText(/station observations are unavailable/i)
  await assertWidth()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Source details' })).toBeFocused()

  const menu = page.getByRole('navigation', { name: 'More in this bulletin' })
  if (width <= 390) {
    const jump = menu.getByRole('link', { name: 'Plan explanation' })
    await expect(jump).toBeInViewport()
    await expect(menu.getByRole('link', { name: 'Field guide' })).toBeInViewport()
    await jump.focus()
    await page.keyboard.press('Enter')
    await expect(explain(page)).toBeFocused()
  } else await explain(page).focus()
  const disclosure = page.locator('.explanation').getByText(/Workers AI/i)
  await expect(disclosure).toContainText(/default/i)
  await expect(disclosure).toContainText(/city/i)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Rule-based explanation' })).toBeVisible()
  await assertWidth()
  if (width <= 390) {
    await page.locator('.explanation').evaluate(el => el.scrollIntoView({ block: 'start' }))
    await screenshot(page, 'after-' + width + '-explanation')
  }
  const guideLink = width <= 390 ? menu.getByRole('link', { name: 'Field guide' })
    : page.getByRole('navigation').getByRole('link', { name: 'Field guide' })
  await guideLink.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Field guide' })).toBeInViewport()
  const indoor = page.getByText('Indoor air', { exact: true })
  if (width <= 390) {
    await expect(page.locator('#guide')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(indoor).toBeFocused()
  } else await indoor.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Indoor air is unmeasured/)).toBeVisible()
  await page.getByRole('button', { name: '24h' }).click()
  const plot = page.locator('#forecast .plot')
  const plottedY = await plot.locator('circle').evaluateAll(points => points.map(p => Number(p.getAttribute('cy'))))
  expect(Math.max(...plottedY) - Math.min(...plottedY)).toBeLessThan(2)
  await expect(plot).toContainText(/25 Nov/)
  await expect(plot).toHaveAccessibleName(/24 Nov.*25 Nov.*midnight/i)
  await expect(page.locator('.chart-note')).toContainText(/no clear lower/i)
  await page.locator('#forecast').evaluate(el => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, 'after-' + width + '-flat-outlook')
  const hourly = page.getByText('View hourly values', { exact: true })
  await hourly.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('row', { name: /25 Nov.*00:30.*153\.25/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /25 Nov.*01:30.*155/ })).toBeVisible()
  await assertWidth()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
})

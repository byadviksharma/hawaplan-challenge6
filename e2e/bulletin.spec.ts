import { test, expect, type Page, type Response } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { screenshot } from './screenshot'
import { stamp, type Bulletin, type City, type Profile } from '../src/domain'
import { makeDecision } from '../src/choices'
import { explanationSchema, modelDetail, ruleDetails, type Explanation } from '../src/contracts'
import { decisionContext } from '../src/explanationFacts'
const hour = 3600000
const morning = Date.parse('2026-11-24T08:30:00+05:30')
// Synthetic data remains inside browser tests. Live evidence below uses no routes.
function fixture(city: City = 'delhi', now = Date.now()): Bulletin {
  const valid = Math.floor(now / hour) * hour
  return {
    city,
    valid,
    retrieved: now,
    aqi: city === 'delhi' ? 155 : 89,
    pm25: 42,
    pm10: 63,
    hours: Array.from({ length: 30 }, (_, i) => ({
      time: valid + i * hour,
      aqi: 120 + Math.round(12 * Math.cos(i / 4)),
    })),
  }
}
async function mockData(page: Page) {
  await page.clock.setFixedTime(morning)
  await page.route('**/api/air?*', (r) =>
    r.fulfill({
      json: fixture(
        new URL(r.request().url()).searchParams.get('city') as City,
        morning,
      ),
    }),
  )
}
async function expectWorkerRules(page: Page, response: Response) {
  expect(response.status()).toBe(200)
  const answer = explanationSchema.parse(await response.json())
  expect(answer.mode).toBe('rules')
  const box = page.locator('.explanation-body')
  await expect(box.getByRole('heading', { name: 'Rule-based explanation', exact: true })).toBeVisible()
  const detail = box.locator('.fine')
  await expect(detail).toBeVisible()
  await expect(detail).toHaveText(answer.detail + ' · Prepared ' + stamp(answer.created))
  return answer
}
test('household changes actions and persists; city, table, guide and accessible controls work', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockData(page)
  await page.goto('/')
  await expect(page).toHaveTitle(/HawaPlan/)
  await expect(page.getByTestId('aqi')).toHaveText('155')
  await page.getByRole('button', { name: 'Source details' }).click()
  await expect(page.getByRole('dialog')).toContainText('Retrieved')
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: 'Source details' }),
  ).toBeFocused()
  await page.getByRole('button', { name: 'Household', exact: true }).click()
  await page
    .getByLabel('Household', { exact: true })
    .selectOption('With children')
  await page.getByLabel('Usual travel').selectOption('Car or two-wheeler')
  await page.getByLabel('Preferred outing period').selectOption('Evening')
  await page.getByLabel('Outdoor activity').selectOption('Playtime')
  await page.getByRole('button', { name: 'Save household' }).click()
  // The chosen activity and its travel context belong to the same period.
  const evening = periodRow(page, 'Evening')
  await expect(evening.getByRole('heading')).toContainText(/play/i)
  await page.reload()
  await expect(evening.getByRole('heading')).toContainText(/play/i)
  await expect(
    page.getByRole('button', { name: /With children.*Car or two-wheeler/ }),
  ).toBeVisible()
  await page.getByLabel('Change city').selectOption('mumbai')
  await expect(page.getByTestId('aqi')).toHaveText('89')
  await page.getByRole('button', { name: '24h' }).click()
  await page.getByText('View hourly values', { exact: true }).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(25)
  await page.getByText('Indoor air', { exact: true }).click()
  await expect(page.getByText(/room-sized|HEPA cleaner sized/)).toBeVisible()
  await page.getByText('Lower-emission choices', { exact: true }).click()
  await expect(page.getByText(/Pair errands/)).toBeVisible()
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([])
  expect(errors).toEqual([])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})
test('honest loading, retry, missing values, stale and offline', async ({
  page,
  context,
}) => {
  let answer = async () => ({ status: 429, json: { error: 'rate' } as unknown })
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/air?*', async (r) => {
    await pending
    await r.fulfill(await answer())
  })
  await page.goto('/')
  await expect(
    page.getByText('Loading conditions', { exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('aqi')).toHaveText('—')
  release()
  await expect(
    page.getByText('Provider rate limit', { exact: true }),
  ).toBeVisible()
  answer = async () => ({ status: 503, json: { error: 'source' } })
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(
    page.getByText('Provider unavailable', { exact: true }),
  ).toBeVisible()
  answer = async () => ({
    status: 200,
    json: { ...fixture(), aqi: null, pm25: null, hours: [] },
  })
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(
    page.getByRole('heading', { name: 'AQI unavailable' }),
  ).toBeVisible()
  await expect(page.locator('#forecast .chart-note')).toContainText(
    /insufficient coverage/i,
  )
  answer = async () => ({
    status: 200,
    json: { ...fixture(), valid: Date.now() - 5 * hour },
  })
  await page.reload()
  await expect(page.getByText('Stale estimate', { exact: true })).toBeVisible()
  await expect(page.locator('#forecast .chart-note')).toContainText(
    /fresh hourly forecast/i,
  )
  // The local Worker must receive no usable evidence when the display is stale.
  const reply = page.waitForResponse('**/api/explain')
  await page.getByRole('button', { name: 'Explain my plan' }).click()
  const response = await reply
  expect(response.request().postDataJSON()).toMatchObject({ valid: null, retrieved: null })
  expect((await expectWorkerRules(page, response)).detail).toBe(ruleDetails.current)
  const staleExplanation = page.locator('.explanation-body')
  await expect(staleExplanation).toContainText(/recheck|fresh forecast/i)
  await expect(staleExplanation.getByText('Alternative', { exact: true })).toHaveCount(0)
  await context.setOffline(true)
  await expect(page.getByText(/Offline · Stale estimate/)).toBeVisible()
  await expect(page.getByTestId('aqi')).toHaveText('155')
  answer = async () => ({ status: 200, json: fixture() })
  await context.setOffline(false)
  await expect(
    page.getByText('Modeled estimate', { exact: true }),
  ).toBeVisible()
})
test('a fresh forecast with an earlier AQI shows the Worker’s current-AQI fallback', async ({ page }) => {
  const data = { ...fixture('delhi', morning), valid: morning - hour }
  await page.clock.setFixedTime(morning)
  await page.route('**/api/air?*', route => route.fulfill({ json: data }))
  // Replay the current-AQI contract while the hourly outlook is still usable.
  await page.route('**/api/explain', route => {
    const { profile } = route.request().postDataJSON()
    const context = decisionContext(data, profile, makeDecision(data, profile, morning), morning)
    return route.fulfill({ json: {
      mode: 'rules', reasoning: null, detail: ruleDetails.current, created: morning, context,
    } })
  })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Earlier modeled reading' })).toBeVisible()
  await expect(page.locator('#forecast .plot')).toBeVisible()
  const reply = page.waitForResponse('**/api/explain')
  await page.getByRole('button', { name: 'Explain my plan' }).click()
  const answer = await expectWorkerRules(page, await reply)
  expect(answer.detail).toBe(ruleDetails.current)
})
test('invalid cached presets recover and late city data cannot replace the next city', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('hawa.v1.profile', '{"people":123}'),
  )
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/air?*', async (r) => {
    const city = new URL(r.request().url()).searchParams.get('city') as City
    if (city === 'delhi') await pending
    await r.fulfill({ json: fixture(city) }).catch(() => {})
  })
  await page.goto('/')
  await page.getByLabel('Change city').selectOption('mumbai')
  await expect(page.getByTestId('aqi')).toHaveText('89')
  release()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mumbai')
  await expect(
    page.getByRole('button', { name: /Adults.*Public transport/ }),
  ).toBeVisible()
})
// Independent cases use a fixed IST clock and CAMS-style hourly timestamps (:30 IST).
// No production planner functions are used to derive the fixtures or their expectations.
async function controlledOutlook(
  page: Page,
  now: number,
  current: number,
  hourlyAQI: (localHour: number, day: number) => number,
) {
  const first = Date.parse('2026-11-24T00:30:00+05:30')
  const data: Bulletin = {
    city: 'delhi',
    valid: now,
    retrieved: now,
    aqi: current,
    pm25: null,
    pm10: null,
    hours: Array.from({ length: 48 }, (_, i) => ({
      time: first + i * hour,
      aqi: hourlyAQI(i % 24, Math.floor(i / 24)),
    })),
  }
  await page.clock.install({ time: new Date(now) })
  await page.route('**/api/air?*', (r) => {
    const city = new URL(r.request().url()).searchParams.get('city')
    return r.fulfill({ json: { ...data, city } })
  })
  await page.goto('/')
  await expect(page.getByTestId('aqi')).toHaveText(String(current))
  return data
}
function periodRow(page: Page, period: string) {
  return page.locator('.timeline li').filter({
    has: page.getByText(period, { exact: true }),
  })
}
async function chooseHousehold(
  page: Page,
  profile: Omit<Profile, 'travel'> & { travel?: Profile['travel'] },
) {
  const household = page.getByRole('button', { name: 'Household', exact: true })
  await household.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page
    .getByLabel('Household', { exact: true })
    .selectOption(profile.people)
  await page.getByLabel('Preferred outing period').selectOption(profile.period)
  await page.getByLabel('Outdoor activity').selectOption(profile.activity)
  if (profile.travel)
    await page.getByLabel('Usual travel').selectOption(profile.travel)
  await page.getByRole('button', { name: 'Save household' }).focus()
  await page.keyboard.press('Enter')
  await expect(household).toBeFocused()
}
function choosePlaytime(page: Page, period: Profile['period']) {
  return chooseHousehold(page, { people: 'With children', period, activity: 'Playtime' })
}
test('moderate morning to hazardous afternoon: honor playtime and show an indoor alternative', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  const afternoonValues = [352, 354, 355, 353, 352]
  await controlledOutlook(page, morning, 55, (h) =>
    h >= 12 && h < 17 ? afternoonValues[h - 12] : 55,
  )
  // This was silently moved to hazardous afternoon play in the original planner.
  await choosePlaytime(page, 'Evening')
  const evening = periodRow(page, 'Evening')
  const afternoon = periodRow(page, 'Afternoon')
  await expect(evening.getByRole('heading')).toContainText(/playtime/i)
  await expect(afternoon.getByRole('heading')).not.toContainText(
    /breaks into playtime/i,
  )
  await expect(evening).toContainText(/moderate|55/i)
  await page
    .locator('#plan-title')
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, info.project.name + '-evening-intent')
  await choosePlaytime(page, 'Afternoon')
  await expect(afternoon.getByRole('heading')).toContainText(
    /playtime indoors|indoor play/i,
  )
  await expect(afternoon).toContainText(/hazardous/i)
  await expect(afternoon).toContainText(/352.*355/)
  await expect(afternoon).not.toContainText(
    /build breaks into playtime|lowest estimate|safer hour/i,
  )
  await expect(page.locator('#forecast .chart-note')).toContainText(
    /hazardous/i,
  )
  await expect(page.locator('#forecast .chart-note')).not.toContainText(
    /lowest estimate|best hour/i,
  )
  if (info.project.name === 'desktop') {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expect(page.getByTestId('aqi')).toBeInViewport()
  } else {
    await page
      .locator('#plan-title')
      .evaluate((el) => el.scrollIntoView({ block: 'start' }))
  }
  const warning = page.getByRole('link', {
    name: /afternoon outing.*playtime indoors/i,
  })
  await expect(warning).toBeInViewport()
  await screenshot(page, info.project.name + '-hazardous')
  await warning.focus()
  await page.keyboard.press('Enter')
  await expect(afternoon).toBeFocused()
  await expect(afternoon.getByText(/hazardous/i)).toBeInViewport()
  const hours = page.getByText('View hourly values', { exact: true })
  await hours.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('row', { name: /12:30.*352/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /14:30.*355/ })).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
  // A controlled outage forces the actual client fallback for this same bulletin.
  await page.route('**/api/explain', (r) => r.abort())
  await page.getByRole('button', { name: 'Explain my plan' }).click()
  await expect(
    page.getByRole('heading', { name: 'Rule-based explanation' }),
  ).toBeVisible()
  await expect(page.locator('.explanation-body')).toContainText(/hazardous/i)
  await expect(page.locator('.explanation-body')).toContainText(/indoor/i)
})
// Fixed reasoning references simulate the Worker reply at the browser boundary.
// Construct only its bulletin identity with shared code. Assert rendered decisions independently.
function modelChoiceFixture(profile: Profile) {
  if (profile.activity === 'Playtime') {
    return {
      prefer: { option: 'indoor', goals: ['keeps-period', 'smoke-free-play'] },
      switchIf: { option: 'later-period', goal: 'keeps-outdoor-activity' },
      cost: 'changes-setting',
      limit: { option: 'later-period', fact: 'recheck-later' },
    }
  }
  return {
    prefer: { option: 'short-list', goals: ['return-after-priority-stop'] },
    switchIf: { option: 'combine-stops', goal: 'avoids-extra-trip' },
    cost: 'leaves-errands-outstanding',
    limit: { option: 'combine-stops', fact: 'no-route-estimate' },
  }
}
test('two households compare feasible choices on the same bulletin (model doubles)', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  const data = await controlledOutlook(page, morning, 55, (h) =>
    h >= 12 && h < 17 ? [352, 354, 355, 353, 352][h - 12] : 55,
  )
  const children: Profile = {
    people: 'With children', period: 'Afternoon', activity: 'Playtime', travel: 'Work from home',
  }
  const older: Profile = {
    people: 'With older adults', period: 'Evening', activity: 'Errands', travel: 'Car or two-wheeler',
  }
  const box = page.locator('.explanation-body')
  const modelHeading = box.getByRole('heading', { name: 'AI-composed explanation' })
  const rulesHeading = box.getByRole('heading', { name: 'Rule-based explanation' })
  const recommended = box.locator('dt').filter({ hasText: /^Recommended$/ }).locator('+ dd')
  const alternative = box.locator('dt').filter({ hasText: /^Alternative$/ }).locator('+ dd')
  let mode: 'valid' | 'swap' | 'changed' | 'offline' | 'unsupported' = 'valid'
  let previous: Explanation | undefined
  const requests: Profile[] = []
  await page.route('**/api/explain', async (r) => {
    if (mode === 'offline') return r.abort()
    if (mode === 'changed') return r.fulfill({ json: previous })
    const { profile } = r.request().postDataJSON() as { profile: Profile }
    const answer: Explanation = {
      created: morning,
      context: decisionContext(data, profile, makeDecision(data, profile, morning), morning),
      mode: 'model',
      detail: modelDetail,
      reasoning: modelChoiceFixture(profile),
    }
    if (mode === 'swap') {
      const swapped = {
        prefer: { option: 'later-period', goals: ['keeps-outdoor-activity'] },
        switchIf: { option: 'indoor', goal: 'keeps-period' },
        cost: 'changes-period',
        limit: { option: 'indoor', fact: 'no-indoor-reading' },
      }
      return r.fulfill({ json: { ...answer, reasoning: swapped } })
    }
    if (mode === 'unsupported') {
      const advice = 'Go outside at 15:00. The air is safe at US AQI 12.'
      return r.fulfill({ json: { ...answer, advice } })
    }
    requests.push(profile)
    previous = answer
    return r.fulfill({ json: answer })
  })
  await chooseHousehold(page, children)
  const button = page.getByRole('button', { name: 'Explain my plan' })
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(modelHeading).toBeVisible()
  await expect(recommended).toContainText(/play.*indoor/i)
  await expect(recommended).toContainText(/incense|candles/i)
  await expect(alternative).toContainText(/evening/i)
  await expect(alternative).toContainText(/playtime outdoors/i)
  await expect(box).toContainText(/hazardous/i)
  await expect(box).toContainText(/352.*355/)
  await expect(box.locator('.decision-source')).toContainText(/Open-Meteo.*CAMS.*24 Nov 2026.*08:30 IST/i)
  await box.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await expect(recommended).toBeInViewport()
  await screenshot(page, info.project.name + '-children-comparison-stub')
  const audit = await new AxeBuilder({ page })
    .include('.explanation')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  expect(audit.violations).toEqual([])

  // A successful result is reused in this edition. Request a fresh response
  // in a new page load to exercise the same adversarial option pairing.
  mode = 'swap'
  await page.reload()
  await expect(page.getByText('Modeled estimate', { exact: true })).toBeVisible()
  await button.click()
  await expect(rulesHeading).toBeVisible()
  await expect(recommended).toContainText(/play.*indoor/i)
  await expect(alternative).toContainText(/evening/i)
  await box.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, info.project.name + '-rejected-fallback')

  mode = 'valid'
  await chooseHousehold(page, older)
  await expect(modelHeading).toHaveCount(0)
  await button.click()
  await expect(modelHeading).toBeVisible()
  await expect(recommended).toContainText(/errands?|short list/i)
  await expect(recommended).toContainText(/head home after the priority stop/i)
  await expect(alternative).toContainText(/combin|group/i)
  await expect(alternative).toContainText(/separate vehicle trip/i)
  await expect(box).toContainText(/route|travel.time/i)
  await expect(box).toContainText(/evening/i)
  await expect(box).toContainText(/moderate/i)
  await expect(box).not.toContainText(/playtime/i)
  expect(requests).toEqual([children, older])
  await box.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await screenshot(page, info.project.name + '-errands-comparison-stub')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  // A valid result for the previous city must not survive a city change or be
  // accepted when replayed against another bulletin with identical hourly values.
  mode = 'changed'
  await page.getByLabel('Change city').selectOption('mumbai')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mumbai')
  await expect(page.getByText('Modeled estimate', { exact: true })).toBeVisible()
  await expect(modelHeading).toHaveCount(0)
  await button.click()
  await expect(rulesHeading).toBeVisible()
  await expect(box.locator('.fine')).toContainText(/conditions changed/i)
  await page.getByLabel('Change city').selectOption('delhi')
  await expect(page.getByText('Modeled estimate', { exact: true })).toBeVisible()
  mode = 'unsupported'
  await button.click()
  await expect(rulesHeading).toBeVisible()
  await expect(box).not.toContainText(/go outside at 15:00|safe at US AQI 12/i)
  await expect(alternative).toContainText(/combin|group/i)
  expect(errors).toEqual([])
  mode = 'offline'
  await page.getByRole('button', { name: 'Explain again' }).click()
  await expect(box.locator('.fine')).toContainText(/service is unavailable/i)
  await expect(rulesHeading).toBeVisible()
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
})
test('small unhealthy differences keep exact table values without advertising a better hour', async ({
  page,
}) => {
  await controlledOutlook(page, morning, 154, (h) =>
    h % 2 === 0 ? 153.25 : 155,
  )
  const note = page.locator('#forecast .chart-note')
  await expect(note).toContainText(/no clear lower|insufficient coverage/i)
  await expect(note).not.toContainText(
    /lowest estimate|safer|best hour|\d{2}:\d{2}/i,
  )
  await page.getByText('View hourly values', { exact: true }).click()
  await expect(page.getByRole('row', { name: /12:30.*153\.25/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /13:30.*155/ })).toBeVisible()
})
test('after 22:00 IST the next actionable row is tomorrow and uses tomorrow’s forecast', async ({
  page,
}, info) => {
  const late = Date.parse('2026-11-24T22:30:00+05:30')
  await controlledOutlook(page, late, 55, (h, day) =>
    day === 1 && h >= 6 && h < 12 ? 340 : 55,
  )
  await choosePlaytime(page, 'Morning')
  const rows = page.locator('.timeline li')
  const first = rows.first()
  await expect(first).toContainText(/morning/i)
  await expect(first).toContainText(/tomorrow/i)
  await expect(first.locator('time')).toHaveAttribute('datetime', /^2026-11-25/)
  await expect(first.getByRole('heading')).toContainText(
    /playtime indoors|indoor play/i,
  )
  await expect(first).toContainText(/hazardous/i)
  for (const row of await rows.all())
    await expect(row).toContainText(/tomorrow/i)
  await page
    .locator('#plan-title')
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await expect(first.getByRole('heading')).toBeInViewport()
  await screenshot(page, info.project.name + '-late-night')
  // The same upcoming morning becomes "Today" while this tab stays open.
  await page.clock.fastForward(91 * 60_000)
  await expect(first).toContainText(/today/i)
  await expect(first.locator('time')).toHaveAttribute('datetime', /^2026-11-25/)
  await expect(first).not.toContainText(/tomorrow/i)
})
test('live provider, source times, city switch and Worker explanation', async ({
  page,
}, info) => {
  test.skip(process.env.HAWAPLAN_LIVE !== '1', 'Explicit live-provider check')
  test.setTimeout(70000)
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  const result = page.waitForResponse((r) =>
    r.url().includes('/api/air?city=delhi'),
  )
  await page.goto('/')
  const response = await result
  expect(response.status()).toBe(200)
  const source = (await response.json()) as Bulletin
  expect(source.city).toBe('delhi')
  expect(source.aqi).not.toBeNull()
  await expect(page.getByTestId('aqi')).toHaveText(
    String(Math.round(source.aqi!)),
  )
  await expect(
    page.getByText('Modeled estimate', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('#forecast .chart-note')).toBeVisible()
  await screenshot(page, info.project.name + '-delhi')
  await page.getByRole('button', { name: 'Source details' }).click()
  await expect(page.getByRole('dialog')).toContainText('Retrieved')
  await screenshot(page, info.project.name + '-source')
  await page.keyboard.press('Escape')
  await page.getByLabel('Change city').selectOption('bengaluru')
  await expect(
    page.getByText('Modeled estimate', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Household', exact: true }).click()
  await page
    .getByLabel('Household', { exact: true })
    .selectOption('With older adults')
  await page.getByLabel('Usual travel').selectOption('Car or two-wheeler')
  await page.getByLabel('Preferred outing period').selectOption('Evening')
  await page.getByLabel('Outdoor activity').selectOption('Errands')
  await screenshot(page, info.project.name + '-household')
  await page.getByRole('button', { name: 'Save household' }).click()
  // Local conditions determine the action. Its period and household intent are fixed.
  const outing = periodRow(page, 'Evening')
  await expect(outing).toContainText(/errand/i)
  await page.getByRole('button', { name: '24h' }).click()
  await page.getByText('View hourly values', { exact: true }).click()
  // At a half-hour IST sample boundary the live horizon holds 24 points;
  // between samples it also shows the timestamp of the in-progress hour.
  const rows = page.getByRole('table').locator('tbody tr')
  await expect(rows.first()).toBeVisible()
  expect([24, 25]).toContain(await rows.count())
  const explanationReply = page.waitForResponse('**/api/explain')
  await page.getByRole('button', { name: 'Explain my plan' }).click()
  const explanationResponse = await explanationReply
  if (process.env.HAWAPLAN_EXPECT_AI === '1') {
    const heading = page.getByRole('heading', {
      name: 'AI-composed explanation',
    })
    await expect(heading).toBeVisible({ timeout: 20000 })
    const choices = page.locator('.explanation-body dd')
    await expect(choices).toHaveCount(2)
    const first = await choices.allTextContents()
    await page.getByRole('button', { name: 'Household', exact: true }).click()
    await page
      .getByLabel('Household', { exact: true })
      .selectOption('With children')
    await page.getByLabel('Usual travel').selectOption('Work from home')
    await page.getByLabel('Outdoor activity').selectOption('Playtime')
    await page.getByRole('button', { name: 'Save household' }).click()
    await page.getByRole('button', { name: 'Explain my plan' }).click()
    await expect(heading).toBeVisible({ timeout: 20000 })
    await expect(choices).toHaveCount(2)
    const second = await choices.allTextContents()
    expect(second).not.toEqual(first)
    await screenshot(page, info.project.name + '-live-ai')
  } else {
    await expectWorkerRules(page, explanationResponse)
    await page.locator('.explanation-body').scrollIntoViewIfNeeded()
    await screenshot(page, info.project.name + '-fallback')
  }
  expect(await page.locator('vite-error-overlay').count()).toBe(0)
  expect(errors).toEqual([])
})

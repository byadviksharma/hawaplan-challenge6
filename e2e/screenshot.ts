import type { Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function screenshot(page: Page, name: string) {
  const dir = process.env.HAWAPLAN_SCREENSHOTS
  if (dir) {
    await mkdir(dir, { recursive: true })
    await page.screenshot({ path: join(dir, name + '.png'), fullPage: false })
  }
}

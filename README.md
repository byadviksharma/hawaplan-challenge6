# HawaPlan

HawaPlan helps households in Delhi, Noida, Gurugram, Mumbai, Kolkata and Bengaluru decide how to plan a walk, playtime, exercise or errands around regional air pollution. Choose a city and set the household, travel mode, preferred outing period and activity. The bulletin gives a dated action, the evidence behind it and indoor or lower-emission options.

## Reading the bulletin

The timeline covers the next three morning, afternoon and evening periods in India Standard Time. The hourly outlook shows 12 or 24 hours of modeled US AQI, with a text summary and a keyboard-accessible table of the supplied values. **Source details** shows coordinates, source validity and retrieval time. The field guide covers household smoke sources, filtration, ventilation and ways to combine trips.

A favorable outing **now** requires both a current modeled AQI and fresh, continuous hourly coverage of the remaining period. The modeled reading must have reached its valid time and be less than one hour old. At exactly one hour the bulletin labels it as earlier. A newly retrieved copy retains its original age. An adverse, relevant sample can still support moving playtime indoors or postponing optional errands when coverage is incomplete.

For example, at 12:05 IST an 11:30 hazardous forecast and a forecast improving from 12:30 can support indoor play for now. If the earlier forecast and current reading are both missing, the family is asked to recheck. The chart leaves a break across the present instant. Each forecast value belongs to its own timestamp.

The planner treats a bulletin as stale after a failed provider check, a source valid time over three hours old or a retrieval over one hour old. It suppresses hourly guidance until a fresh bulletin arrives. Saved bulletins expire after 24 hours. A complete forecast can still inform a conditional **future** outing when a current AQI is unavailable and the bulletin is fresh.

## Run locally

Use Node.js 24.16 or newer within the 24.x series and npm. Run these commands from the project root.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite, usually `http://127.0.0.1:5173`. The default Worker retrieves public air data over HTTPS and uses rule-based explanations. This setup requires no account or API key. To serve the production build locally, run the build followed by the preview.

```sh
npm run build
npm run preview -- --port 4173 --strictPort
```

## Architecture and explanations

| Component | Responsibility |
| --- | --- |
| React, TypeScript and Vite | Render conditions, the plan, the chart and explanations. `makeHouseholdPlan` builds the timeline and selects its outing from one bulletin, household profile and instant. The Worker uses the same planner for its decision. |
| `GET /api/air?city=delhi` | The Cloudflare Worker resolves a supported city to fixed coordinates, validates the provider’s timestamps, units, values and hourly arrays with Zod, and caches the bulletin for reuse. |
| `POST /api/explain` | The Worker independently resolves the bulletin and checks the browser’s decision revision, including current-reading eligibility. The browser retires an explanation when its supporting facts change. |
| Optional Workers AI | When a current modeled AQI and two supported choices are available, Google Gemma weighs their trade-offs. It can favor only an option the planner permits. The Worker and browser validate the model’s option and evidence references. The application supplies the displayed facts, numbers and wording. |

**Explain my plan** identifies whether the answer is model-composed or rule-based. Missing current evidence, a single supported action, unavailable bindings, rate limits and unverified model outputs yield labeled rules. If the decision changes during a request, the old comparison is discarded. The model is `@cf/google/gemma-4-26b-a4b-it`. [Workers AI model details](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)

The Worker handles HTTP methods, origins and request bodies in `worker/index.ts`. `worker/air.ts` manages bulletin caching and provider backoff. `worker/explanation.ts` checks the displayed evidence before inference and rechecks it before returning the answer. Provider failures and unexpected internal errors have distinct diagnostic events.

Protocol 2 hashes a shared evidence record in `src/explanationEvidence.ts`. It includes the city, source values and validity, household presets, dated outing and alternative windows, forecast samples and coverage, eligible options, and their evidence IDs. The Worker checks retrieval freshness separately so a new retrieval can confirm the same facts. A verified response carries the digest and stable identifiers. The browser resolves the wording against its own plan.

Keep IDs stable across copy edits. Bump the decision policy version when safety thresholds or the meaning of an ID change. Unversioned clients still verify the original English decision and response labels byte for byte. Preserve that representation while those clients are supported.

## Accessibility and privacy

Severity and freshness have text labels. Keyboard users can open the hourly table, operate the household and source dialogs, and return focus to the control that opened them. The interface respects reduced-motion preferences.

City, household presets and recent bulletins use browser local storage. Clearing site data removes them. The app requires no login or precise location. Requesting an explanation sends the city, presets, source timestamps and decision revision to the Worker. When eligible inference is enabled, the Worker uses the client IP for rate limiting and sends the model the household presets, supported choices and regional air facts.

## Data and attribution

Open-Meteo supplies modeled US AQI, PM2.5 and PM10 from the Copernicus Atmosphere Monitoring Service (CAMS) global forecast, produced by ECMWF. Particulate concentrations use µg/m³. At roughly 45 km resolution, nearby cities can share a grid cell. The product has no street-level station feed or indoor sensor. The displayed index uses the US scale. [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) · [CAMS global atmospheric composition forecasts, DOI 10.24381/04a0b097](https://doi.org/10.24381/04a0b097)

City-centre coordinates were checked using Open-Meteo geocoding, which credits GeoNames. The application groups supplied readings into periods and summarizes their ranges. Open-Meteo licenses its API data under CC BY 4.0. Its free hosted endpoint has separate non-commercial use and request limits. [Geocoding attribution](https://open-meteo.com/en/docs/geocoding-api#attribution) · [GeoNames](https://www.geonames.org/) · [Data licence](https://open-meteo.com/en/licence) · [API terms](https://open-meteo.com/en/terms)

The interface uses Lucide icons. License texts and notices for bundled third-party components accompany the public assets. [Third-party notices](public/THIRD-PARTY-NOTICES.txt)

## Tests

Run these commands from the project root in a shell with `CLOUDFLARE_ENV` and `HAWAPLAN_TEST_URL` unset. Stop any manual preview on port 4173 first. The examples use POSIX shell syntax.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
CI=1 npm run test:e2e
```

With `CI=1`, Playwright starts a fresh local preview of the default build. With `HAWAPLAN_LIVE` unset, it runs 57 controlled browser cases. To include the three public Open-Meteo journeys, run `CI=1 HAWAPLAN_LIVE=1 HAWAPLAN_EXPECT_AI=0 npm run test:e2e`. The default build has no AI binding. `HAWAPLAN_EXPECT_AI` controls the test assertion. To use an installed Google Chrome, set `PLAYWRIGHT_CHANNEL=chrome` in the test environment.

| Public release verification at `e402b908` | Scope |
| --- | --- |
| 187 unit and Worker tests passed | Provider and cache validation, freshness, household planning, HTTP and explanation contracts, error diagnostics and fallback behavior. |
| 60 Playwright tests passed | Production preview in Chrome at 1440 × 1000, 390 × 844 and 320 × 844, including three live Delhi/Bengaluru provider journeys. Model-composed responses used test doubles. |
| 15 scoped axe scans found zero violations | Selected browser states, supplemented by keyboard, focus and viewport checks. |

## Production verification

The public Worker is `hawaplan-inference` on Cloudflare Workers Free. Hosted checks confirmed anonymous access, static asset and API routing, and live Delhi and Bengaluru bulletins. Both cities’ current readings and 96 hourly US AQI samples per city matched Open-Meteo. One genuine Gemma request returned a model-composed explanation, and the browser displayed both supported choices. A separate request with missing air data returned the labeled rule-based explanation. [Open HawaPlan](https://hawaplan-inference.byadviksharma.workers.dev)

Eight scoped axe scans in desktop and touch-emulated mobile Chrome found zero violations. On an iPhone 15 running Safari, a participant reported passing all seven manual checks. These covered initial load, city switching, household personalization, persistence, forecast and source controls, basic accessibility and usability, and connection-loss handling in an already open app. Full VoiceOver support and offline cold starts remain unverified.

## Deployment configuration

The Cloudflare Vite plugin builds the browser assets and Worker together. In `wrangler.jsonc`, `/api/*` goes to the Worker and other application routes use the single-page asset fallback. The default build omits AI bindings. Before deployment, an authorized operator selects the target account and Worker name and reviews provider terms and usage allowances.

For an inference-enabled build, verify that the configured `namespace_id` is dedicated to HawaPlan explanations in the target account. When deploying to another account, select an unused integer there. This identifier selects a rate-limit namespace. The `inference` environment supplies the remote `AI` binding and an `EXPLANATIONS` limiter configured for five requests per client per minute per Cloudflare location. The model call has a 12-second timeout and a 350-token output limit. Keep deployment credentials in the operator’s Wrangler session or CI secret store. [Rate-limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

Select the environment **at build time** with `CLOUDFLARE_ENV=inference npm run build`. For the default rules-only build, leave `CLOUDFLARE_ENV` unset. Preview uses the generated configuration. After verifying that configuration and the destination account, an authorized operator can deploy the selected build from the project root with `npx wrangler deploy`. [Cloudflare Vite environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)

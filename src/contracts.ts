import { z } from 'zod'
import { citySchema, profileSchema, timestamp } from './domain'

export const explanationProtocol = 2
const protocol = z.literal(explanationProtocol)
const revision = z.string().regex(/^[0-9a-f]{64}$/)
const requestFields = {
  city: citySchema,
  profile: profileSchema,
  valid: timestamp.nullable(),
}
const legacyRequest = z.strictObject({
  ...requestFields, retrieved: timestamp.nullable().optional(), revision: revision.optional(),
})
const semanticRequest = z.strictObject({
  ...requestFields, protocol, revision, retrieved: timestamp.nullable(),
}).refine(input => (input.valid === null) === (input.retrieved === null))

export const requestSchema = z.union([semanticRequest, legacyRequest])

export type ExplanationRequest = z.infer<typeof requestSchema>

const reference = z.string().min(1).max(64).regex(/^[a-z][a-z-]*$/)
export const reasoningSchema = z.strictObject({
  prefer: z.strictObject({
    option: reference,
    goals: z.array(reference).min(1).max(2),
  }),
  switchIf: z.strictObject({ option: reference, goal: reference }),
  cost: reference,
  limit: z.strictObject({ option: reference, fact: reference }),
})
export type Reasoning = z.infer<typeof reasoningSchema>

const metadata = { created: timestamp, context: z.string().min(1).max(16000) }
const ruleDetailCode = z.enum(['current', 'single', 'binding', 'limit', 'unverified'])
export type RuleDetailCode = z.infer<typeof ruleDetailCode>

export const modelDetail = 'Gemma 4 weighed the household choices against this bulletin.'
export const ruleDetails = {
  current: 'A fresh current US AQI is needed for an AI explanation.',
  single: 'The planner has one supported action for this outing.',
  binding: 'Workers AI is not connected to this planner.',
  limit: 'Explanation limit reached. Try again in a minute.',
  unverified: 'The AI service could not return a verified comparison.',
} as const satisfies Record<RuleDetailCode, string>

export const explanationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...metadata,
    mode: z.literal('model'),
    detail: z.literal(modelDetail),
    reasoning: reasoningSchema,
  }),
  z.strictObject({
    ...metadata,
    mode: z.literal('rules'),
    detail: z.enum(ruleDetails),
    reasoning: z.null(),
  }),
])
export type Explanation = z.infer<typeof explanationSchema>

// The public response above carries literal English labels. New clients resolve
// these detail codes locally and compare the verified revision before rendering.
const semanticMetadata = { protocol, revision, created: timestamp }
export const semanticExplanationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...semanticMetadata, mode: z.literal('model'), detail: z.literal('model'), reasoning: reasoningSchema,
  }),
  z.strictObject({
    ...semanticMetadata, mode: z.literal('rules'),
    detail: ruleDetailCode, reasoning: z.null(),
  }),
])
export type SemanticExplanation = z.infer<typeof semanticExplanationSchema>

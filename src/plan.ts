export type Plan = 'free' | 'plus' | 'pro'

export function planName(plan: Plan) {
  return plan === 'plus' ? 'Plus' : plan === 'pro' ? 'Pro' : 'Free'
}

export function planPrice(plan: Plan) {
  return plan === 'plus' ? 5 : plan === 'pro' ? 15 : 0
}

export function hasScanner(plan: Plan) {
  return plan === 'plus' || plan === 'pro'
}

/** Plan → engine mapping. Pro must never be routed to V2. */
export function engineForPlan(plan: Plan): 'V1' | 'V2' | 'V3' {
  if (plan === 'pro') return 'V3'
  if (plan === 'plus') return 'V2'
  return 'V1'
}

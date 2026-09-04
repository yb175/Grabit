// @grabit/config — central env config for the Grabit monorepo.
//
// Grabit is an AI Payment Revenue Recovery system. All services (Hono API,
// BullMQ workers, Python AI agent) read their settings from here so there is
// exactly one place where an env var is interpreted.
//
// Eventually: typed config for Razorpay keys, WhatsApp provider, AI agent URL,
// timing/stopping rule knobs. Chunk 1: the essentials.

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

export const config = {
  port: Number(process.env.PORT ?? 3100),
  databaseUrl: required('DATABASE_URL', 'postgresql://grabit:grabit@localhost:5433/grabit'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6380'),
  aiAgentUrl: required('AI_AGENT_URL', 'http://localhost:8001'),
  // Razorpay webhook signing secret (Dashboard -> Settings -> Webhooks).
  // Optional at boot: verification fails closed when unset.
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  // Razorpay API keys & settings
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  razorpayApiUrl: process.env.RAZORPAY_API_URL ?? 'https://api.razorpay.com',
  razorpayPaymentLinkEnabled: process.env.RAZORPAY_PAYMENT_LINK_ENABLED === 'true',
  waProvider: process.env.WA_PROVIDER ?? 'mock',
  waPhoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  waAccessToken: process.env.WA_ACCESS_TOKEN,
  waTemplateName: process.env.WA_TEMPLATE_NAME ?? 'payment_failed_recover',
  waTemplateLang: process.env.WA_TEMPLATE_LANG ?? 'en_US',
  waGraphApiUrl: process.env.WA_GRAPH_API_URL ?? 'https://graph.facebook.com/v21.0',
}

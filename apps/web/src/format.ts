// Formatting helpers — money and IDs are JetBrains Mono, always ₹, no $.

const INR = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function fmtINR(amount: number): string {
  return `₹${INR.format(amount)}`
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

const FAILURE_LABELS: Record<string, string> = {
  hard: 'Hard',
  soft: 'Soft',
  autopay_failed: 'Autopay failed',
  autopay_cancelled: 'Autopay cancelled',
}

export function failureLabel(type: string): string {
  return FAILURE_LABELS[type] ?? type
}
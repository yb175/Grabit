# Database Schema & Data Models

Located in: `packages/db/prisma/schema.prisma`  
Database: PostgreSQL 16 (Port 5433)

---

## 1. Entity-Relationship (ER) Diagram

```
+---------------------------+             +---------------------------+
|      failed_payments      | 1         1 |       recovery_jobs       |
+---------------------------+-------------+---------------------------+
| id (PK, UUID)             |             | id (PK, UUID)             |
| razorpay_payment_id (UQ)  |             | failed_payment_id (FK)    |
| razorpay_order_id         |             | status (enum)             |
| amount (Decimal 12,2 INR) |             | failure_type (enum)       |
| currency (default: 'INR') |             | follow_up_count (int)     |
| failure_code / reason     |             | max_follow_ups (default 2)|
| failure_source (enum)     |             | next_attempt_at (tz)      |
| customer_phone / email    |             | created_at / updated_at   |
| raw_payload (jsonb)       |             +-------------+-------------+
+---------------------------+                           |
                                      +-----------------+-----------------+
                                    1 |                                 1 |
                                      v                                   v
                        +---------------------------+       +---------------------------+
                        |     recovery_messages     |       |        hitl_tasks         |
                        +---------------------------+       +---------------------------+
                        | id (PK, UUID)             |       | id (PK, UUID)             |
                        | recovery_job_id (FK)      |       | recovery_job_id (FK)      |
                        | template_name             |       | status (enum)             |
                        | rendered_body (text)      |       | priority (enum)           |
                        | recovery_url (text)       |       | reason (text)             |
                        | status (enum)             |       | reviewer_notes (text)     |
                        | sent_at / delivered_at    |       | assigned_to / resolved_at |
                        +---------------------------+       +---------------------------+
                                                                          |
                                      +-----------------------------------+
                                    1 |
                                      v
                        +---------------------------+       +---------------------------+
                        |      recovery_ledger      |       |        audit_logs         |
                        +---------------------------+       +---------------------------+
                        | id (PK, UUID)             |       | id (PK, UUID)             |
                        | recovery_job_id (FK, UQ)  |       | entity_type (text)        |
                        | failed_payment_id (FK)    |       | entity_id (UUID)          |
                        | amount (Decimal 14,2 INR) |       | action (text)             |
                        | status (enum)             |       | actor_type / actor_id     |
                        | recovery_method (enum)    |       | old_state / new_state(jb) |
                        | recovered_at (tz)         |       | created_at (tz)           |
                        +---------------------------+       +---------------------------+
```

---

## 2. Enums Reference

```prisma
enum RecoveryJobStatus {
  pending       // Ingested, awaiting recovery worker evaluation
  processing    // Passed stopping rules, AI diagnosis / action in progress
  waiting       // Scheduled delay (quiet hours, salary window, gap)
  hitl          // Escalated to human reviewer
  recovered     // Successfully recovered, ledger recorded
  unrecovered   // Exhausted max attempts or hard decline
  rejected      // Human reviewer rejected outreach
  stale         // 24h inactivity threshold passed
}

enum FailureType {
  hard                // Fraud, card blocked, invalid instrument
  soft                // Insufficient funds, transient bank timeout
  autopay_failed      // UPI Autopay mandate debit failure
  autopay_cancelled   // Mandate revoked by user/bank
}

enum HitlStatus {
  pending       // In reviewer queue
  approved      // Reviewer approved proposed message/action
  rejected      // Reviewer rejected outreach
}

enum LedgerStatus {
  recovered     // Revenue successfully recovered
  unrecovered   // Job closed without recovery
}

enum RecoveryMethod {
  retry             // Retried through original payment method
  one_click         // Customer used one-click payment link
  mandate_reauth    // Autopay mandate re-authorized
  manual            // Recovered manually via human agent
}
```

---

## 3. Monetary Representation Invariants

- **Standard Currency**: All monetary columns (`failed_payments.amount`, `recovery_ledger.amount`) are stored as **PostgreSQL `Decimal` in INR Rupees**.
- **Ingestion Boundary**: Razorpay sends amounts in integer paise (e.g. `100000` paise = `1000.00` rupees). Division by 100 occurs exclusively at the ingestion boundary:
  ```typescript
  const amount = payment ? new Prisma.Decimal(payment.amount).div(100) : new Prisma.Decimal(0)
  ```
- **Arithmetic Precision**: The rest of the platform (ledger, worker calculations, stopping rules threshold checks, dashboard aggregation) operates entirely on decimal Rupees with zero floating-point roundoff errors.

---

## 4. Immutable Audit Logs

The `audit_logs` model provides a polymorphic change log capturing all state transitions across the platform:

```prisma
model AuditLog {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  entityType  String   @map("entity_type") // e.g. "recovery_jobs"
  entityId    String   @map("entity_id") @db.Uuid
  action      String   // e.g. "scheduled_delay", "escalated_hitl", "stop_recovered"
  oldValue    Json?    @map("old_value") @db.JsonB
  newValue    Json?    @map("new_value") @db.JsonB
  performedBy String   @default("system") @map("performed_by")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([entityType, entityId])
  @@index([action, createdAt])
  @@map("audit_logs")
}
```

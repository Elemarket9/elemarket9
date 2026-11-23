# ELEMARKET merchant wallet — end-to-end simulation

Run: 2026-11-10T12:58:17.737Z · PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) · database `elemarket_wallet_6716c9f1_test` (disposable)

All payment and payout provider outcomes below are **SIMULATED**. Delivery uses the real rider-OTP handover records with every database guard active; the handover instant is the controlled test clock.

### 1. Customer payment (SIMULATED collection) → verified order
Collected GH₵ 115.00 = products GH₵ 100.00 + delivery GH₵ 15.00. Marketplace commission GH₵ 5.00; merchant earning GH₵ 95.00 credited as **withheld** (pending delivery). Charge kept in the platform provider account (no split).

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| after | 95.00 | 0.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 2. Delivery → rider OTP handover 30 hours ago
Order marked delivered through the real OTP handover guards. Earnings stay withheld until the release job runs.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 95.00 | 0.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| after | 95.00 | 0.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 3. 24-hour hold expired → release to available
Released 1 order(s). Running the release again released 0 (idempotent).

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 95.00 | 0.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| after | 95.00 | 0.00 | 0.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 4. Order inside the hold (handover 2 hours ago) stays withheld
Withdrawing more than available was refused: _amount exceeds available balance_.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 95.00 | 0.00 | 0.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| after | 190.00 | 0.00 | 95.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 5. Partial withdrawal GH₵ 40.00 → SIMULATED provider pays
Fee GH₵ 1.00 paid by the merchant; GH₵ 39.00 sent. Status: **paid**, provider transfers: 1.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 190.00 | 0.00 | 95.00 | 95.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| after | 190.00 | 0.00 | 95.00 | 55.00 | 0.00 | 39.00 | 1.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 6. Five concurrent withdrawal requests (different devices)
1 accepted, 4 refused (_a withdrawal is already in progress_). No over-reservation.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 190.00 | 0.00 | 95.00 | 55.00 | 0.00 | 39.00 | 1.00 | 0.00 |
| after | 190.00 | 0.00 | 95.00 | 35.00 | 0.00 | 58.00 | 2.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 7. SIMULATED provider failure → reservation released once
Provider reported failure at once. Status: **failed**; funds back in available.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 190.00 | 0.00 | 95.00 | 35.00 | 0.00 | 58.00 | 2.00 | 0.00 |
| after | 190.00 | 0.00 | 95.00 | 35.00 | 0.00 | 58.00 | 2.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 8. SIMULATED provider timeout → uncertain → read back → one transfer
After the timeout: **uncertain** (funds stay reserved). Attempts: send:uncertain → lookup:not_found → send:accepted. Final: **paid**, transfers: 1.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 190.00 | 0.00 | 95.00 | 35.00 | 0.00 | 58.00 | 2.00 | 0.00 |
| after | 190.00 | 0.00 | 95.00 | 25.00 | 0.00 | 67.00 | 3.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 9. Missing callback → reconciliation finds the payment
No notification arrived; read-back settled it as **paid**.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 190.00 | 0.00 | 95.00 | 25.00 | 0.00 | 67.00 | 3.00 | 0.00 |
| after | 190.00 | 0.00 | 95.00 | 15.00 | 0.00 | 76.00 | 4.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 10. Refund before withdrawal (order still on hold)
SIMULATED provider refund of GH₵ 115.00 processed; the merchant's share left the withheld balance.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 190.00 | 0.00 | 95.00 | 15.00 | 0.00 | 76.00 | 4.00 | 0.00 |
| after | 285.00 | 95.00 | 95.00 | 15.00 | 0.00 | 76.00 | 4.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 11. Refund competing with a withdrawal
Withdrawal of all GH₵ 110.00: refused (amount exceeds available balance). The refund was booked; anything already paid out is recorded as owed (recovery) and repaid from future releases, never as a negative balance.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 285.00 | 95.00 | 95.00 | 15.00 | 0.00 | 76.00 | 4.00 | 0.00 |
| after | 380.00 | 190.00 | 95.00 | 15.00 | 0.00 | 76.00 | 4.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 12. Duplicate payout attempt (same request twice; SIMULATED provider double-send)
Same request twice → same withdrawal (one payout). The simulated provider then sent a transfer twice; reconciliation raised: **duplicate_external_payout** (critical).

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 380.00 | 190.00 | 95.00 | 15.00 | 0.00 | 76.00 | 4.00 | 0.00 |
| after | 475.00 | 190.00 | 95.00 | 80.00 | 0.00 | 104.00 | 6.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

### 13. Crash after submission → restart → recovery
Worker process exited with code 137 right after the SIMULATED provider accepted the transfer. Recorded state: **submitting**. After restart: read back, then **paid**, provider transfers: 1.

| Ledger | total_sales | refunded | withheld | available | processing | paid_out | payout_fees | recovery_due |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 475.00 | 190.00 | 95.00 | 80.00 | 0.00 | 104.00 | 6.00 | 0.00 |
| after | 475.00 | 190.00 | 95.00 | 70.00 | 0.00 | 113.00 | 7.00 | 0.00 |

Invariant (every cedi in one bucket, nothing negative): **holds**

## Final reconciliation

```json
{
  "buckets": {
    "fees": 7,
    "paid_out": 113,
    "withheld": 95,
    "available": 70,
    "processing": 0
  },
  "deliveryFees": 75,
  "openExceptions": {
    "duplicate_external_payout": 1
  },
  "payoutsByStatus": {
    "paid": {
      "net": 113,
      "fees": 7,
      "count": 7,
      "amount": 120
    },
    "failed": {
      "net": 9,
      "fees": 1,
      "count": 1,
      "amount": 10
    }
  },
  "customerCollections": 575,
  "invariantViolations": 0,
  "merchantEntitlements": 475,
  "merchantRefundDebits": 190,
  "marketplaceCommission": 25
}
```

Invariant violations: **0**. Open exceptions are deliberate (step 12) and stay open until staff resolve them with a written resolution.

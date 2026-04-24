# AI Agent Integration Guide

The WorkAlong AI agent lets clients talk in plain language and translates requests into API calls using a `wak_` API key.

```
Client (chat)  →  AI Agent (holds wak_ key)  →  WorkAlong API  →  Agent  →  Client
```

**Auth on every request:**
```
Authorization: Bearer wak_<key>
Content-Type: application/json
```
No session cookies. No CSRF tokens.

---

## Agent behaviour rules

1. **Never call a mutating endpoint (POST / PUT / DELETE) until all required fields are confirmed.**
2. **If a required field is missing, ask the user for it before proceeding.**
3. **If an optional field would meaningfully improve the result, ask for it.**
4. **Always confirm destructive actions (delete, process payroll, bulk approve) before executing.**
5. **After every successful mutation, summarise what was done in plain language.**

---

## Base request helper

```js
const BASE = 'https://your-host/api';
const KEY  = process.env.WORKALONG_API_KEY;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status, data });
  return data;
}
```

---

## Tool definitions

Each section below defines one agent tool. Every tool lists:
- **Triggers** — example user messages
- **Required fields** — must be present before calling the API; ask the user if missing
- **Optional fields** — ask only if relevant or if the user seems to want more control
- **Clarifying questions** — exact questions to ask per missing field
- **HTTP call** — the exact request to make once all required fields are resolved
- **Response** — what the API returns
- **Confirm before executing** — whether to ask the user to confirm first

---

### SHIFTS

---

#### `getShifts` — Read the schedule

**Triggers:** "show shifts", "what's on this week", "schedule for [staff name]", "shifts in [date range]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `startDate` | `YYYY-MM-DD` | "What start date would you like? (e.g. 2026-04-21)" |
| `endDate` | `YYYY-MM-DD` | "What end date would you like? (e.g. 2026-04-27)" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `staffId` | number | Ask "Would you like shifts for a specific staff member, or everyone?" |
| `status` | `scheduled` \| `clocked_in` \| `attended` \| `approved` \| `late` \| `review` | Ask if user mentions a status ("only approved shifts", "who's late") |

**HTTP call:**
```
GET /shifts?startDate={startDate}&endDate={endDate}[&staffId={id}][&status={status}]
```

**Response:** `{ shifts: [...] }` — each shift has `id`, `staffId`, `staffName`, `shiftDate`, `startTime`, `hours`, `status`, `location`.

---

#### `createShift` — Add a single shift

**Triggers:** "add a shift", "create a shift for [name]", "schedule [name] for [day]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `staffId` | number | "Which staff member? (I can look up the list if needed)" |
| `shiftDate` | `YYYY-MM-DD` | "What date is the shift?" |
| `startTime` | `HH:MM` (24h) | "What time does the shift start? (e.g. 09:00)" |
| `hours` | number (0.5–24) | "How many hours long is the shift?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `breakMinutes` | number | Ask "Is there a break? If so, how many minutes?" |
| `shiftType` | `regular` \| `overtime` \| `leave` | Ask if user mentions leave or overtime |
| `payType` | `paid` \| `unpaid` | Ask if `shiftType` is `leave` |
| `location` | string | Ask if multi-location account: "Which location?" |
| `notes` | string | Ask "Any notes for this shift?" if user seems to want to add context |

**Confirm before executing:** No — single shift creation is low risk.

**HTTP call:**
```
POST /shifts
Body: { staffId, shiftDate, startTime, hours, breakMinutes?, shiftType?, payType?, location?, notes? }
```

**Response:** `{ shift: { id, staffId, staffName, shiftDate, startTime, hours, status: "scheduled", ... } }`

---

#### `createShiftsBulk` — Add multiple shifts at once

**Triggers:** "add shifts for the whole week", "create shifts for multiple staff", "bulk schedule"

> ⚠️ Requires active subscription. Return `403` message if not subscribed.

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `shifts` | array of shift objects | Collect each shift's `staffId`, `shiftDate`, `startTime`, `hours` before calling. Ask for each one individually or accept a list. |

Each object in `shifts` follows the same required/optional fields as `createShift`.

**Confirm before executing:** Yes — "I'm about to create {n} shifts. Shall I go ahead?"

**HTTP call:**
```
POST /shifts/bulk
Body: { shifts: [ { staffId, shiftDate, startTime, hours, ... }, ... ] }
```

**Response:** `{ shifts: [...] }` — all created shifts.

---

#### `updateShift` — Edit a shift

**Triggers:** "change shift [id]", "update [name]'s shift on [date]", "move shift to [time]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | "Which shift ID would you like to update? (I can look up shifts if you give me a date or name)" |
| At least one field to change | — | "What would you like to change? (start time, hours, date, notes…)" |

**Updatable fields** (send only what's changing):

| Field | Type |
|---|---|
| `shiftDate` | `YYYY-MM-DD` |
| `startTime` | `HH:MM` |
| `hours` | number |
| `breakMinutes` | number |
| `shiftType` | `regular` \| `overtime` \| `leave` |
| `payType` | `paid` \| `unpaid` |
| `location` | string |
| `notes` | string |
| `clockedInTime` | `HH:MM` |
| `clockedOutTime` | `HH:MM` |

**Confirm before executing:** No.

**HTTP call:**
```
PUT /shifts/{id}
Body: { ...only the fields being changed }
```

**Response:** `{ shift: { ...updated shift } }`

---

#### `deleteShift` — Remove a shift

**Triggers:** "delete shift [id]", "remove [name]'s shift on [date]", "cancel that shift"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | "Which shift ID should I delete? I can look up shifts to find it." |

**Confirm before executing:** Yes — "This will permanently delete shift {id} for {staffName} on {shiftDate} and remove any linked time entries. Are you sure?"

**HTTP call:**
```
DELETE /shifts/{id}
```

**Response:** `{ message: "Shift deleted" }`

---

#### `approveShift` — Approve one shift

**Triggers:** "approve shift [id]", "approve [name]'s shift", "mark shift as approved"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | "Which shift ID would you like to approve?" |

**Confirm before executing:** No.

**HTTP call:**
```
POST /shifts/{id}/approve
```

**Response:** `{ shift: { ...updated }, timeEntry: { ... } }` — creates or updates the linked time entry.

---

#### `approveShiftsBulk` — Approve multiple shifts

**Triggers:** "approve all shifts", "bulk approve", "approve shifts [list of ids]"

> ⚠️ Requires active subscription.

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `shiftIds` | number[] | "Which shift IDs should I approve? Or should I approve all attended shifts in a date range?" |

**Confirm before executing:** Yes — "I'm about to approve {n} shifts. Confirm?"

**HTTP call:**
```
POST /shifts/approve-bulk
Body: { shiftIds: [1, 2, 3] }
```

**Response:** `{ approved: number, shifts: [...] }`

---

### STAFF

---

#### `getStaff` — List all staff

**Triggers:** "list staff", "who works here", "show me the team", "find [name]"

No required fields.

**HTTP call:**
```
GET /staff
```

**Response:** `{ staff: [ { id, name, role, hourlyRate, employmentType, status, email }, ... ] }`

> Use this to resolve a name to a `staffId` before any other operation.

---

#### `addStaff` — Create a staff member

**Triggers:** "add staff", "new employee", "hire [name]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `name` | string | "What is the staff member's full name?" |
| `role` | string | "What is their role or job title?" |
| `hourlyRate` | number (£) | "What is their hourly rate in pounds?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `email` | string | "Do they have an email address? They'll receive a password setup link." |
| `employmentType` | `full-time` \| `part-time` \| `contractor` | Ask "What's their employment type?" |

**Confirm before executing:** No.

**HTTP call:**
```
POST /staff
Body: { name, role, hourlyRate, email?, employmentType? }
```

**Response:** `{ staff: { id, name, role, hourlyRate, employmentType, status: "active" } }`

---

#### `updateStaff` — Edit a staff member

**Triggers:** "update [name]", "change [name]'s rate", "promote [name]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | Resolve from name via `getStaff` first |
| At least one field | — | "What would you like to change?" |

**Updatable fields:**

| Field | Type |
|---|---|
| `name` | string |
| `role` | string |
| `hourlyRate` | number |
| `email` | string |
| `employmentType` | `full-time` \| `part-time` \| `contractor` |
| `status` | `active` \| `inactive` |

**Confirm before executing:** No.

**HTTP call:**
```
PUT /staff/{id}
Body: { ...only the fields being changed }
```

**Response:** `{ staff: { ...updated } }`

---

#### `deleteStaff` — Remove a staff member

**Triggers:** "remove [name]", "delete [name]", "fire [name]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | Resolve from name via `getStaff` first |

**Confirm before executing:** Yes — "This will permanently delete {name} and all their shifts and time entries. Are you sure?"

**HTTP call:**
```
DELETE /staff/{id}
```

**Response:** `{ message: "Staff deleted" }`

---

### TIME ENTRIES

---

#### `getTimeEntries` — View logged hours

**Triggers:** "show hours", "time entries for [name]", "hours this month"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `startDate` | `YYYY-MM-DD` | "From which date?" |
| `endDate` | `YYYY-MM-DD` | "To which date?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `staffId` | number | "For a specific staff member or everyone?" |

**HTTP call:**
```
GET /time-entries?startDate={startDate}&endDate={endDate}[&staffId={id}]
```

**Response:** `{ timeEntries: [ { id, staffId, staffName, date, hoursWorked, overtimeHours, cost, source, leaveCategory }, ... ] }`

---

#### `logHours` — Add a manual time entry

**Triggers:** "log hours for [name]", "add time entry", "[name] worked [n] hours on [date]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `staffId` | number | Resolve from name via `getStaff` |
| `date` | `YYYY-MM-DD` | "What date were the hours worked?" |
| `hoursWorked` | number | "How many regular hours?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `overtimeHours` | number | "Were any of those overtime hours?" |
| `leaveCategory` | `paid_leave` \| `unpaid_leave` \| `sick` | Ask if user mentions leave or sickness |
| `notes` | string | "Any notes to attach?" |

**Confirm before executing:** No.

**HTTP call:**
```
POST /time-entries
Body: { staffId, date, hoursWorked, overtimeHours?, notes?, leaveCategory? }
```

**Response:** `{ timeEntry: { id, staffId, date, hoursWorked, overtimeHours, cost, source: "manual" } }`

---

#### `updateTimeEntry` — Edit a time entry

**Triggers:** "correct hours for [name]", "fix time entry [id]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | "Which time entry ID? I can look them up if you give me a staff member and date." |
| At least one field | — | "What needs to change?" |

**HTTP call:**
```
PUT /time-entries/{id}
Body: { staffId, date, hoursWorked, overtimeHours?, notes?, leaveCategory? }
```

**Response:** `{ timeEntry: { ...updated } }`

---

#### `deleteTimeEntry` — Remove a time entry

**Triggers:** "delete time entry [id]", "remove hours logged on [date] for [name]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | Resolve via `getTimeEntries` if not given |

**Confirm before executing:** Yes — "Delete time entry {id} for {name} on {date}? This cannot be undone."

**HTTP call:**
```
DELETE /time-entries/{id}
```

**Response:** `{ message: "Time entry deleted" }`

---

#### `approveTimeEntry` — Approve a pending entry

**Triggers:** "approve [name]'s hours", "approve time entry [id]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | Resolve via `GET /time-entries/pending` if not given |

**HTTP call:**
```
POST /time-entries/{id}/approve
```

**Response:** `{ timeEntry: { ...approved } }`

---

### PAYROLL

---

#### `getPayrollPreview` — Preview payroll cost

**Triggers:** "what's payroll for [month/period]", "how much do I owe staff", "payroll preview"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `startDate` | `YYYY-MM-DD` | "What is the start of the payroll period?" |
| `endDate` | `YYYY-MM-DD` | "What is the end of the payroll period?" |

**HTTP call:**
```
GET /payroll-preview?startDate={startDate}&endDate={endDate}
```

**Response:** `{ payroll: [ { staffId, staffName, hoursWorked, overtimeHours, regularPay, overtimePay, totalPay }, ... ], totalCost: number }`

---

#### `processStaffPayroll` — Pay one staff member

**Triggers:** "pay [name]", "process payment for [name]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `staffId` | number | Resolve via `getStaff` |
| `periodStart` | `YYYY-MM-DD` | "What is the start of the pay period?" |
| `periodEnd` | `YYYY-MM-DD` | "What is the end of the pay period?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `amount` | number | Only ask if user wants to override the calculated amount: "Should I use the calculated amount from clocked hours, or do you want to specify a custom amount?" |
| `notes` | string | "Any notes for this payment?" |

**Confirm before executing:** Yes — "I'm about to process a payment for {name} covering {periodStart} to {periodEnd}. The calculated amount is £{amount}. Confirm?"

**HTTP call:**
```
POST /payments/process/{staffId}
Body: { periodStart, periodEnd, amount?, notes? }
```

**Response:** `{ payment: { id, staffId, amount, status, periodStart, periodEnd } }`

---

#### `processAllPayroll` — Pay all staff

**Triggers:** "run payroll", "pay everyone", "process all payments for [period]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `periodStart` | `YYYY-MM-DD` | "What is the start of the pay period?" |
| `periodEnd` | `YYYY-MM-DD` | "What is the end of the pay period?" |

**Confirm before executing:** Yes — "I'm about to process payroll for all eligible staff for {periodStart} to {periodEnd}. This cannot be undone. Confirm?"

**HTTP call:**
```
POST /payments/process-all
Body: { periodStart, periodEnd }
```

**Response:** `{ processed: number, payments: [...] }`

---

#### `getPaymentSchedule` — View current schedule

**Triggers:** "what's the payment schedule", "when do staff get paid"

No required fields.

**HTTP call:**
```
GET /payments/schedule
```

**Response:** `{ schedule: { scheduleType, paymentDay, nextPaymentDate } }` or `null` if none set.

---

#### `setPaymentSchedule` — Set payment schedule

**Triggers:** "set pay schedule to weekly", "pay staff every Friday", "change payment day"

**Required fields:**

| Field | Type | Valid values | Clarifying question |
|---|---|---|---|
| `scheduleType` | string | `weekly` \| `bi-weekly` \| `monthly` \| `custom` | "How often should staff be paid? (weekly / bi-weekly / monthly / custom)" |
| `paymentDay` | string | Day name or date, e.g. `"Friday"`, `"1"` | "Which day? (e.g. Friday for weekly, or 1st for monthly)" |

**HTTP call:**
```
POST /payments/schedule
Body: { scheduleType, paymentDay, customSchedule? }
```

**Response:** `{ schedule: { scheduleType, paymentDay, nextPaymentDate } }`

---

### BUDGET

---

#### `getBudgetStats` — View budget status

**Triggers:** "budget status", "how much have we spent", "are we over budget"

No required fields.

**HTTP call:**
```
GET /budgets/stats
```

**Response:** `{ monthlyBudget, spent, remaining, percentageUsed, isOverBudget }`

---

#### `createBudget` — Set a budget

**Triggers:** "set a budget", "create budget of £[amount]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `name` | string | "What would you like to call this budget?" |
| `monthlyBudget` | number | "What is the monthly budget in pounds?" |
| `startDate` | `YYYY-MM-DD` | "From which date does this budget start?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `endDate` | `YYYY-MM-DD` | "Does this budget have an end date, or is it ongoing?" |

**HTTP call:**
```
POST /budgets
Body: { name, monthlyBudget, startDate, endDate? }
```

**Response:** `{ budget: { id, name, monthlyBudget, startDate, endDate, status } }`

---

#### `updateBudget` — Change the budget

**Triggers:** "update budget", "change budget to £[amount]", "increase budget"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | Resolve via `GET /budgets/active` if not given |
| At least one field | — | "What would you like to change?" |

**HTTP call:**
```
PUT /budgets/{id}
Body: { name?, monthlyBudget?, startDate?, endDate?, status? }
```

**Response:** `{ budget: { ...updated } }`

---

### FRAUD DETECTION

> All fraud endpoints require an active subscription. If `403` is returned, tell the client: "Fraud detection requires a Professional subscription."

---

#### `analyzeStaff` — Check one staff member

**Triggers:** "check [name] for fraud", "any suspicious activity for [name]"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `staffId` | number | Resolve via `getStaff` |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `days` | number (default 30) | "How many days back should I analyse? (default is 30)" |

**HTTP call:**
```
POST /fraud/analyze/{staffId}
Body: { days? }
```

**Response:** `{ flagsCreated: number, flags: [...] }`

---

#### `analyzeAllStaff` — Run fraud check on everyone

**Triggers:** "run fraud check", "check all staff for suspicious activity"

**Confirm before executing:** Yes — "I'll analyse all staff for suspicious activity. This may take a moment. Confirm?"

**HTTP call:**
```
POST /fraud/analyze-all
```

**Response:** `{ staffAnalyzed: number, flagsCreated: number }`

---

#### `getFraudFlags` — View fraud alerts

**Triggers:** "show fraud alerts", "any red flags", "open fraud flags for [name]"

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `staffId` | number | "For a specific staff member or everyone?" |
| `includeResolved` | boolean | "Include already-resolved flags?" |

**HTTP call:**
```
GET /fraud/flags[?staffId={id}][&includeResolved=true]
```

**Response:** `{ flags: [ { id, staffId, staffName, type, description, severity, resolved, createdAt }, ... ] }`

---

#### `resolveFraudFlag` — Mark a flag as resolved

**Triggers:** "resolve flag [id]", "dismiss fraud alert [id]", "mark as false positive"

**Required fields:**

| Field | Type | Clarifying question |
|---|---|---|
| `id` | number | "Which flag ID would you like to resolve?" |

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `notes` | string | "Any notes on why this is being resolved?" |

**HTTP call:**
```
PUT /fraud/flags/{id}/resolve
Body: { notes? }
```

**Response:** `{ flag: { ...resolved flag } }`

---

### LOCATIONS & KIOSK

---

#### `updateGeofence` — Set the workplace location

**Triggers:** "update office location", "change geofence radius", "set workplace to [address]"

**Required fields (at least one):**

| Field | Type | Clarifying question |
|---|---|---|
| `latitude` | number | "What is the latitude of the location?" |
| `longitude` | number | "What is the longitude?" |
| `radius` | number (10–10000 m) | "What radius in metres? (e.g. 100 for 100m)" |

**HTTP call:**
```
PUT /location
Body: { latitude?, longitude?, radius? }
```

---

#### `generateKioskLink` — Create a clock-in kiosk link

**Triggers:** "new kiosk link", "set up clock-in for [device name]"

**Optional fields:**

| Field | Type | When to ask |
|---|---|---|
| `deviceName` | string | "What should this device be called? (e.g. Front Desk)" |
| `expiresInDays` | number | "How many days should this link last? (leave blank for no expiry)" |

**HTTP call:**
```
POST /clockin/generate-link
Body: { deviceName?, expiresInDays? }
```

**Response:** `{ url: "https://...", token: "...", deviceName }`

---

## Error handling

| Status | Error | What to tell the client |
|---|---|---|
| `400` | Validation error | Relay the `error` field from the response directly |
| `401` | Invalid API key | Internal — do not expose; log and alert |
| `403 Premium subscription required` | Subscription needed | "This feature requires a Professional subscription" |
| `403` (other) | CSRF / permission | Internal — re-check key scopes |
| `404` | Not found | "I couldn't find that shift / staff member / entry" |
| `409` | Conflict | "There's already a shift at that time for that person" |
| `429` | Rate limit | "I'm processing too many requests — please try again in a moment" |
| `500` | Server error | "Something went wrong on our end — please try again" |

---

## Key management

| Action | Endpoint |
|---|---|
| Create a key | `POST /api/security/api-keys` (session + CSRF, from browser) |
| List keys | `GET /api/security/api-keys` |
| Revoke a key | `POST /api/security/api-keys/:keyId/revoke` |
| Delete a key | `DELETE /api/security/api-keys/:keyId` |

---

## Note on obfuscation

In production, request and response bodies are XOR-encoded (see `OBFUSCATION.md`). In development (`NODE_ENV=dev` + `DISABLE_OBFUSCATION=true`) plain JSON is used and all examples above work as-is.

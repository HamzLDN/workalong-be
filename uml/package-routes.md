# Route registration (package view)

`registerRoutes(app)` in `routes/index.js` — mount paths.

```mermaid
flowchart TB
  App[Express app] --> Reg[registerRoutes]

  Reg --> H["/api/health"]
  Reg --> C["/api/contact"]
  Reg --> A["/api/auth"]
  Reg --> L1["/api/location"]
  Reg --> L2["/api/locations"]
  Reg --> S1["/api/staff"]
  Reg --> CK["/api/clockin"]
  Reg --> SH["/api → shifts"]
  Reg --> B["/api/budgets"]
  Reg --> TE["/api → time-entries"]
  Reg --> F["/api/fraud"]
  Reg --> P1["/api/payment"]
  Reg --> AC["/api/activities"]
  Reg --> SE["/api/security"]
  Reg --> P2["/api/payments"]
```

Note: `shifts` and `time-entries` both mount on `/api`; their routers define paths like `/shifts`, `/time-entries`, etc. See each `routes/*.js` file for exact HTTP paths.

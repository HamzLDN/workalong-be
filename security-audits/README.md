# Security Audits

This folder contains security audit reports and test results for the WorkAlong application.

## Contents

- **SECURITY-AUDIT-IDOR.md** - IDOR (Insecure Direct Object Reference) vulnerability audit report
- **SECURITY-TEST-RESULTS-FINAL.md** - Final security test results
- **SECURITY-TEST-COMPLETE.md** - Complete security test documentation
- **SECURITY-TEST-RESULTS.md** - Initial security test results
- **SESSION-TOKEN-TEST-RESULTS.md** - Session token security test results

## Running Security Tests

### Automated IDOR Tests
```bash
npm test -- __tests__/security-idor.test.js
```

### Manual API Security Tests
```bash
./scripts/test-idor-vulnerabilities.sh
```

## Security Guides

For security implementation guides and documentation, see:
- `README-SECURITY.md` - Main security documentation
- `SECURITY-QUICKSTART.md` - Quick start guide for security features
- `SECURITY-SESSION-TOKENS.md` - Session token security guide
- `ENDPOINT-SECURITY-GUIDE.md` - API endpoint security guide


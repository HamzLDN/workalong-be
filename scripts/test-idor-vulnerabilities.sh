#!/bin/bash
# Security Test Script: IDOR (Insecure Direct Object Reference) Vulnerability Testing
# This script tests if users can access other users' data

set -e

API_URL="${API_URL:-http://localhost:8080/api}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "🔒 Testing IDOR Vulnerabilities"
echo "=============================="
echo ""

# Create two test users
echo -e "${BLUE}Setting up test users...${NC}"
USER1_EMAIL="testuser1@example.com"
USER1_PASSWORD="testpass123"
USER2_EMAIL="testuser2@example.com"
USER2_PASSWORD="testpass123"

# Sign up user 1
echo -e "${BLUE}Creating User 1...${NC}"
USER1_RESPONSE=$(curl -s -c /tmp/user1_cookies.txt -X POST "$API_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER1_EMAIL\",\"password\":\"$USER1_PASSWORD\",\"name\":\"Test User 1\"}")

if echo "$USER1_RESPONSE" | grep -q "session"; then
  USER1_SESSION=$(echo "$USER1_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -1)
  echo -e "${GREEN}✅ User 1 created${NC}"
else
  echo -e "${YELLOW}⚠️  User 1 may already exist, trying signin...${NC}"
  USER1_SIGNIN=$(curl -s -c /tmp/user1_cookies.txt -X POST "$API_URL/auth/signin" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$USER1_EMAIL\",\"password\":\"$USER1_PASSWORD\"}")
  USER1_SESSION=$(echo "$USER1_SIGNIN" | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -1)
fi

# Sign up user 2
echo -e "${BLUE}Creating User 2...${NC}"
USER2_RESPONSE=$(curl -s -c /tmp/user2_cookies.txt -X POST "$API_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER2_EMAIL\",\"password\":\"$USER2_PASSWORD\",\"name\":\"Test User 2\"}")

if echo "$USER2_RESPONSE" | grep -q "session"; then
  USER2_SESSION=$(echo "$USER2_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -1)
  echo -e "${GREEN}✅ User 2 created${NC}"
else
  echo -e "${YELLOW}⚠️  User 2 may already exist, trying signin...${NC}"
  USER2_SIGNIN=$(curl -s -c /tmp/user2_cookies.txt -X POST "$API_URL/auth/signin" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$USER2_EMAIL\",\"password\":\"$USER2_PASSWORD\"}")
  USER2_SESSION=$(echo "$USER2_SIGNIN" | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -1)
fi

# Get CSRF tokens
echo -e "${BLUE}Getting CSRF tokens...${NC}"
USER1_CSRF=$(curl -s -b /tmp/user1_cookies.txt "$API_URL/auth/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)
USER2_CSRF=$(curl -s -b /tmp/user2_cookies.txt "$API_URL/auth/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)

echo ""
echo -e "${BLUE}=== Testing Staff Access Control ===${NC}"

# User 1 creates a staff member
echo -e "${BLUE}User 1 creating staff member...${NC}"
STAFF1_RESPONSE=$(curl -s -b /tmp/user1_cookies.txt -X POST "$API_URL/staff" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $USER1_CSRF" \
  -H "Authorization: Bearer $USER1_SESSION" \
  -d '{"name":"Staff Member 1","role":"Manager","hourlyRate":20,"employmentType":"full-time"}')

STAFF1_ID=$(echo "$STAFF1_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo -e "${GREEN}✅ User 1 created staff member with ID: $STAFF1_ID${NC}"

# User 2 tries to access User 1's staff member
echo -e "${BLUE}User 2 attempting to access User 1's staff member (ID: $STAFF1_ID)...${NC}"
STAFF_ACCESS=$(curl -s -b /tmp/user2_cookies.txt -X GET "$API_URL/staff/$STAFF1_ID" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

if echo "$STAFF_ACCESS" | grep -q "not found\|404"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot access User 1's staff member${NC}"
else
  echo -e "${RED}❌ VULNERABILITY: User 2 can access User 1's staff member!${NC}"
  echo "Response: $STAFF_ACCESS"
fi

# User 2 tries to update User 1's staff member
echo -e "${BLUE}User 2 attempting to update User 1's staff member...${NC}"
STAFF_UPDATE=$(curl -s -b /tmp/user2_cookies.txt -X PUT "$API_URL/staff/$STAFF1_ID" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION" \
  -d '{"name":"Hacked Staff","role":"Hacker","hourlyRate":999}')

if echo "$STAFF_UPDATE" | grep -q "not found\|404"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot update User 1's staff member${NC}"
else
  echo -e "${RED}❌ VULNERABILITY: User 2 can update User 1's staff member!${NC}"
  echo "Response: $STAFF_UPDATE"
fi

echo ""
echo -e "${BLUE}=== Testing Shift Access Control ===${NC}"

# User 1 creates a shift
echo -e "${BLUE}User 1 creating shift...${NC}"
SHIFT1_RESPONSE=$(curl -s -b /tmp/user1_cookies.txt -X POST "$API_URL/shifts" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $USER1_CSRF" \
  -H "Authorization: Bearer $USER1_SESSION" \
  -d "{\"staffId\":$STAFF1_ID,\"shiftDate\":\"2026-02-15\",\"startTime\":\"09:00\",\"hours\":8}")

SHIFT1_ID=$(echo "$SHIFT1_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo -e "${GREEN}✅ User 1 created shift with ID: $SHIFT1_ID${NC}"

# User 2 tries to access User 1's shift
echo -e "${BLUE}User 2 attempting to access User 1's shift (ID: $SHIFT1_ID)...${NC}"
SHIFT_ACCESS=$(curl -s -b /tmp/user2_cookies.txt -X GET "$API_URL/shifts/$SHIFT1_ID" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

if echo "$SHIFT_ACCESS" | grep -q "not found\|404"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot access User 1's shift${NC}"
else
  echo -e "${RED}❌ VULNERABILITY: User 2 can access User 1's shift!${NC}"
  echo "Response: $SHIFT_ACCESS"
fi

# User 2 tries to delete User 1's shift
echo -e "${BLUE}User 2 attempting to delete User 1's shift...${NC}"
SHIFT_DELETE=$(curl -s -b /tmp/user2_cookies.txt -X DELETE "$API_URL/shifts/$SHIFT1_ID" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

if echo "$SHIFT_DELETE" | grep -q "not found\|404"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot delete User 1's shift${NC}"
else
  echo -e "${RED}❌ VULNERABILITY: User 2 can delete User 1's shift!${NC}"
  echo "Response: $SHIFT_DELETE"
fi

echo ""
echo -e "${BLUE}=== Testing Budget Access Control ===${NC}"

# User 1 creates a budget
echo -e "${BLUE}User 1 creating budget...${NC}"
BUDGET1_RESPONSE=$(curl -s -b /tmp/user1_cookies.txt -X POST "$API_URL/budgets" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $USER1_CSRF" \
  -H "Authorization: Bearer $USER1_SESSION" \
  -d '{"name":"Test Budget","monthlyBudget":5000,"startDate":"2026-02-01"}')

BUDGET1_ID=$(echo "$BUDGET1_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo -e "${GREEN}✅ User 1 created budget with ID: $BUDGET1_ID${NC}"

# User 2 tries to access User 1's budgets
echo -e "${BLUE}User 2 attempting to access User 1's budgets...${NC}"
BUDGETS_ACCESS=$(curl -s -b /tmp/user2_cookies.txt -X GET "$API_URL/budgets" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

if echo "$BUDGETS_ACCESS" | grep -q "\"budgets\":\[\]\|\[\]"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot see User 1's budgets${NC}"
else
  if echo "$BUDGETS_ACCESS" | grep -q "$BUDGET1_ID"; then
    echo -e "${RED}❌ VULNERABILITY: User 2 can see User 1's budgets!${NC}"
    echo "Response: $BUDGETS_ACCESS"
  else
    echo -e "${GREEN}✅ SECURE: User 2 cannot see User 1's budgets${NC}"
  fi
fi

# User 2 tries to update User 1's budget
echo -e "${BLUE}User 2 attempting to update User 1's budget...${NC}"
BUDGET_UPDATE=$(curl -s -b /tmp/user2_cookies.txt -X PUT "$API_URL/budgets/$BUDGET1_ID" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION" \
  -d '{"name":"Hacked Budget","monthlyBudget":999999,"startDate":"2026-02-01"}')

if echo "$BUDGET_UPDATE" | grep -q "not found\|404\|permission"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot update User 1's budget${NC}"
else
  echo -e "${RED}❌ VULNERABILITY: User 2 can update User 1's budget!${NC}"
  echo "Response: $BUDGET_UPDATE"
fi

echo ""
echo -e "${BLUE}=== Testing API Key Access Control ===${NC}"

# User 1 creates an API key
echo -e "${BLUE}User 1 creating API key...${NC}"
API_KEY1_RESPONSE=$(curl -s -b /tmp/user1_cookies.txt -X POST "$API_URL/security/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $USER1_CSRF" \
  -H "Authorization: Bearer $USER1_SESSION" \
  -d '{"keyName":"Test API Key","rateLimitPerMinute":60,"rateLimitPerHour":1000}')

API_KEY1_ID=$(echo "$API_KEY1_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo -e "${GREEN}✅ User 1 created API key with ID: $API_KEY1_ID${NC}"

# User 2 tries to access User 1's API keys
echo -e "${BLUE}User 2 attempting to access User 1's API keys...${NC}"
API_KEYS_ACCESS=$(curl -s -b /tmp/user2_cookies.txt -X GET "$API_URL/security/api-keys" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

if echo "$API_KEYS_ACCESS" | grep -q "\"keys\":\[\]\|\[\]"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot see User 1's API keys${NC}"
else
  if echo "$API_KEYS_ACCESS" | grep -q "$API_KEY1_ID"; then
    echo -e "${RED}❌ VULNERABILITY: User 2 can see User 1's API keys!${NC}"
    echo "Response: $API_KEYS_ACCESS"
  else
    echo -e "${GREEN}✅ SECURE: User 2 cannot see User 1's API keys${NC}"
  fi
fi

# User 2 tries to delete User 1's API key
echo -e "${BLUE}User 2 attempting to delete User 1's API key...${NC}"
API_KEY_DELETE=$(curl -s -b /tmp/user2_cookies.txt -X DELETE "$API_URL/security/api-keys/$API_KEY1_ID" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

if echo "$API_KEY_DELETE" | grep -q "not found\|404"; then
  echo -e "${GREEN}✅ SECURE: User 2 cannot delete User 1's API key${NC}"
else
  echo -e "${RED}❌ VULNERABILITY: User 2 can delete User 1's API key!${NC}"
  echo "Response: $API_KEY_DELETE"
fi

echo ""
echo -e "${BLUE}=== Testing Security Audit Logs Access Control ===${NC}"

# User 2 tries to access User 1's audit logs
echo -e "${BLUE}User 2 attempting to access audit logs...${NC}"
AUDIT_LOGS=$(curl -s -b /tmp/user2_cookies.txt -X GET "$API_URL/security/audit-logs" \
  -H "X-CSRF-Token: $USER2_CSRF" \
  -H "Authorization: Bearer $USER2_SESSION")

# Check if logs contain User 1's events (we can't easily verify this without knowing User 1's ID)
# But we can check if the endpoint returns data that shouldn't be accessible
if echo "$AUDIT_LOGS" | grep -q "\"logs\":\[\]\|\[\]"; then
  echo -e "${GREEN}✅ SECURE: User 2's audit logs are empty (expected)${NC}"
else
  echo -e "${YELLOW}⚠️  User 2 can see audit logs (may be their own)${NC}"
fi

echo ""
echo -e "${BLUE}=== Summary ===${NC}"
echo "Security tests completed. Review the results above."
echo ""
echo "If any vulnerabilities were found (marked with ❌), they need to be fixed immediately."
echo "All secure endpoints should be marked with ✅"


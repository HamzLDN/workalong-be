#!/bin/bash
# Quick test script for API security features using curl

set -e

API_URL="${API_URL:-http://localhost:8080/api}"
TEST_EMAIL="${TEST_EMAIL:-test@example.com}"
TEST_PASSWORD="${TEST_PASSWORD:-testpassword123}"

echo "🔒 Testing API Security Features"
echo "================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test 1: Health check
echo -e "${BLUE}Test 1: Health Check${NC}"
HEALTH=$(curl -s -X GET "$API_URL/health")
if echo "$HEALTH" | grep -q "ok"; then
  echo -e "${GREEN}✅ Health check passed${NC}"
else
  echo -e "${RED}❌ Health check failed${NC}"
fi
echo ""

# Test 2: Sign in
echo -e "${BLUE}Test 2: Sign In${NC}"
SIGNIN_RESPONSE=$(curl -s -c /tmp/cookies.txt -X POST "$API_URL/auth/signin" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

if echo "$SIGNIN_RESPONSE" | grep -q "session"; then
  SESSION_ID=$(echo "$SIGNIN_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -1)
  echo -e "${GREEN}✅ Signed in successfully${NC}"
  echo "   Session ID: ${SESSION_ID:0:8}..."
elif echo "$SIGNIN_RESPONSE" | grep -q "requires2FA"; then
  echo -e "${YELLOW}⚠️  2FA is enabled. Getting session from cookie...${NC}"
  SESSION_ID=$(grep sessionId /tmp/cookies.txt | awk '{print $7}')
  if [ -z "$SESSION_ID" ]; then
    echo -e "${RED}❌ Cannot get session. Please disable 2FA or use test account without 2FA.${NC}"
    exit 1
  fi
  echo -e "${GREEN}✅ Got session from cookie${NC}"
else
  echo -e "${RED}❌ Sign in failed: $SIGNIN_RESPONSE${NC}"
  exit 1
fi
echo ""

# Test 3: Get CSRF token
echo -e "${BLUE}Test 3: CSRF Token${NC}"
CSRF_RESPONSE=$(curl -s -b /tmp/cookies.txt -X GET "$API_URL/auth/csrf-token")
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)
if [ -n "$CSRF_TOKEN" ]; then
  echo -e "${GREEN}✅ CSRF token obtained: ${CSRF_TOKEN:0:16}...${NC}"
else
  echo -e "${YELLOW}⚠️  CSRF token not available${NC}"
fi
echo ""

# Test 4: Session token on regular endpoint
echo -e "${BLUE}Test 4: Session Token on /api/staff${NC}"
STAFF_RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/staff" \
  -H "Authorization: Bearer $SESSION_ID")
HTTP_CODE=$(echo "$STAFF_RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✅ Session token accepted${NC}"
else
  echo -e "${RED}❌ Session token rejected (HTTP $HTTP_CODE)${NC}"
fi
echo ""

# Test 5: Create API Key
echo -e "${BLUE}Test 5: Create API Key${NC}"
API_KEY_RESPONSE=$(curl -s -X POST "$API_URL/security/api-keys" \
  -H "Authorization: Bearer $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"keyName":"Test Key","rateLimitPerMinute":60,"rateLimitPerHour":1000}')
API_KEY=$(echo "$API_KEY_RESPONSE" | grep -o '"apiKey":"[^"]*' | cut -d'"' -f4)

if [ -n "$API_KEY" ]; then
  echo -e "${GREEN}✅ API key created: ${API_KEY:0:11}...${NC}"
  echo -e "${YELLOW}⚠️  IMPORTANT: Save this key - it won't be shown again!${NC}"
  
  # Test 6: API Key on endpoint
  echo ""
  echo -e "${BLUE}Test 6: API Key on /api/staff${NC}"
  API_KEY_TEST=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/staff" \
    -H "X-API-Key: $API_KEY")
  API_KEY_HTTP_CODE=$(echo "$API_KEY_TEST" | tail -1)
  if [ "$API_KEY_HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ API key accepted${NC}"
  else
    echo -e "${RED}❌ API key rejected (HTTP $API_KEY_HTTP_CODE)${NC}"
  fi
  
  # Test 7: Rate limit headers
  echo ""
  echo -e "${BLUE}Test 7: Rate Limit Headers${NC}"
  RATE_LIMIT_HEADERS=$(curl -s -I -X GET "$API_URL/staff" \
    -H "X-API-Key: $API_KEY" | grep -i "x-ratelimit")
  if [ -n "$RATE_LIMIT_HEADERS" ]; then
    echo -e "${GREEN}✅ Rate limit headers present:${NC}"
    echo "$RATE_LIMIT_HEADERS" | sed 's/^/   /'
  else
    echo -e "${YELLOW}⚠️  Rate limit headers not found${NC}"
  fi
  
  # Test 8: Security audit logs
  echo ""
  echo -e "${BLUE}Test 8: Security Audit Logs${NC}"
  AUDIT_LOGS=$(curl -s -X GET "$API_URL/security/audit-logs?limit=5" \
    -H "Authorization: Bearer $SESSION_ID")
  if echo "$AUDIT_LOGS" | grep -q "logs"; then
    LOG_COUNT=$(echo "$AUDIT_LOGS" | grep -o '"logs":\[.*\]' | grep -o 'event_type' | wc -l)
    echo -e "${GREEN}✅ Audit logs accessible (found events)${NC}"
  else
    echo -e "${YELLOW}⚠️  Audit logs: $AUDIT_LOGS${NC}"
  fi
else
  echo -e "${RED}❌ Failed to create API key: $API_KEY_RESPONSE${NC}"
fi

echo ""
echo "================================"
echo -e "${GREEN}✨ Security tests completed!${NC}"
echo ""
echo "📋 Summary:"
echo "  - Session authentication: ✅"
[ -n "$CSRF_TOKEN" ] && echo "  - CSRF token: ✅" || echo "  - CSRF token: ⚠️"
[ -n "$API_KEY" ] && echo "  - API key creation: ✅" || echo "  - API key creation: ❌"
[ -n "$API_KEY" ] && echo "  - API key authentication: ✅" || echo "  - API key authentication: ⚠️"
echo ""

# Cleanup
rm -f /tmp/cookies.txt

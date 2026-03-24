#!/bin/bash
# NLU Accuracy Test Harness
# Tests all 39 intents against Mercury NLU (IndicBERTv2)
# Usage: ./scripts/test-nlu-accuracy.sh [mercury_host]

MERCURY_HOST="${1:-192.168.0.151}"
NLU_PORT="7012"
NLU_URL="http://${MERCURY_HOST}:${NLU_PORT}/classify"
PASS=0
FAIL=0
TOTAL=0
MIN_CONFIDENCE=0.65

echo "==========================================="
echo " NLU Accuracy Test — $(date)"
echo " Endpoint: ${NLU_URL}"
echo " Min confidence: ${MIN_CONFIDENCE}"
echo "==========================================="
echo ""

# Test function
test_intent() {
  local message="$1"
  local expected="$2"
  local description="$3"

  TOTAL=$((TOTAL + 1))

  result=$(curl -s -X POST "${NLU_URL}" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"${message}\"}" 2>/dev/null)

  if [ -z "$result" ]; then
    echo "  FAIL [#${TOTAL}] ${description}"
    echo "        Message: \"${message}\""
    echo "        Error: No response from NLU server"
    FAIL=$((FAIL + 1))
    return
  fi

  intent=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('intent',''))" 2>/dev/null)
  confidence=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('confidence',0):.3f}\")" 2>/dev/null)

  if [ "$intent" = "$expected" ]; then
    # Check confidence threshold
    passes_conf=$(python3 -c "print('yes' if float('${confidence}') >= ${MIN_CONFIDENCE} else 'no')")
    if [ "$passes_conf" = "yes" ]; then
      PASS=$((PASS + 1))
      echo "  PASS [#${TOTAL}] ${expected} (${confidence}) — ${description}"
    else
      FAIL=$((FAIL + 1))
      echo "  WARN [#${TOTAL}] ${expected} (${confidence} < ${MIN_CONFIDENCE}) — ${description}"
      echo "        LOW CONFIDENCE: \"${message}\""
    fi
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL [#${TOTAL}] Expected: ${expected}, Got: ${intent} (${confidence}) — ${description}"
    echo "        Message: \"${message}\""
  fi
}

echo "--- CORE FOOD ORDERING ---"
test_intent "I want to order biryani" "order_food" "English food order"
test_intent "mujhe pizza chahiye" "order_food" "Hindi food order"
test_intent "2 butter chicken order karo" "order_food" "Hinglish with quantity"
test_intent "chicken fried rice dedo" "order_food" "Hinglish casual"

echo ""
echo "--- BROWSE & DISCOVERY ---"
test_intent "show me the menu" "browse_menu" "Browse menu"
test_intent "menu dikhao" "browse_menu" "Hindi browse menu"
test_intent "which restaurants are open" "check_availability" "Restaurant availability"
test_intent "show pizza section" "browse_category" "Browse category"
test_intent "other restaurants dikhao" "browse_stores" "Browse other stores"
test_intent "show me restaurants nearby" "browse_stores" "Browse restaurants"
test_intent "best biryani kahan milega" "ask_recommendation" "Recommendation"
test_intent "sabse famous kya hai" "ask_recommendation" "Famous dishes (model merges with recommendation)"
test_intent "jaldi khana chahiye urgently" "ask_fastest_delivery" "Fastest delivery"
test_intent "kitne ka hai pizza" "ask_price" "Price inquiry"
test_intent "delivery time kya hai" "ask_time" "Delivery time inquiry"

echo ""
echo "--- PARCEL / DELIVERY ---"
test_intent "send a parcel" "parcel_booking" "English parcel"
test_intent "parcel bhejo" "parcel_booking" "Hindi parcel"
test_intent "book a courier pickup" "parcel_booking" "Courier booking"
test_intent "I want to send a package to my friend" "parcel_booking" "Package to friend"

echo ""
echo "--- CART & CHECKOUT ---"
test_intent "add to cart" "add_to_cart" "Add to cart"
test_intent "show my cart" "view_cart" "View cart"
test_intent "remove pizza from cart" "remove_from_cart" "Remove from cart"
test_intent "increase quantity to 3" "update_quantity" "Update quantity"
test_intent "place order" "checkout" "Checkout"
test_intent "number 2 select karo" "select_item" "Select item"

echo ""
echo "--- ORDER MANAGEMENT ---"
test_intent "where is my order" "track_order" "Track order"
test_intent "cancel my order" "cancel_order" "Cancel order"
test_intent "repeat last order" "repeat_order" "Repeat order"

echo ""
echo "--- CONVERSATION CONTROL ---"
test_intent "yes" "confirm" "Yes maps to confirm in model"
test_intent "haan ji" "confirm" "Hindi yes maps to confirm"
test_intent "ok sure" "affirm" "Affirm"
test_intent "no" "deny" "Deny"
test_intent "nahi" "deny" "Hindi deny"
test_intent "confirm order" "checkout" "Confirm order = checkout intent"
test_intent "cancel karo" "cancel_order" "Cancel maps to cancel_order"
test_intent "start over from beginning" "restart" "Restart"

echo ""
echo "--- SUPPORT & AUTH ---"
test_intent "I need help" "help" "Help request"
test_intent "I have a complaint" "complaint" "Complaint"
test_intent "talk to a human" "human_takeover" "Human takeover request"
test_intent "login" "login" "Login"
test_intent "save this address as home" "manage_address" "Manage address"
test_intent "what vehicles do you have for parcel" "service_inquiry" "Service inquiry"

echo ""
echo "--- GREETINGS & CHITCHAT ---"
test_intent "hello" "greeting" "English greeting"
test_intent "namaste" "greeting" "Hindi greeting"
test_intent "how are you" "chitchat" "Chitchat"
test_intent "what can you do for me" "chitchat" "Capabilities question"
test_intent "thank you" "chitchat" "Thanks"

echo ""
echo "--- E-COMMERCE ---"
test_intent "find headphones" "search_product" "Search product"
test_intent "show me laptops" "search_product" "Product search"

echo ""
echo "--- FEEDBACK ---"
test_intent "great service" "feedback" "Positive feedback"
test_intent "food was terrible" "feedback" "Negative feedback"

echo ""
echo "--- EDGE CASES (known issues) ---"
test_intent "send biryani to my friend" "parcel_booking" "Ambiguous: parcel vs food"
test_intent "use my home address" "use_saved" "Use saved address"
test_intent "ye wala select karo" "select_item" "Hinglish select"

echo ""
echo "==========================================="
echo " RESULTS"
echo "==========================================="
echo " Total:  ${TOTAL}"
echo " Passed: ${PASS}"
echo " Failed: ${FAIL}"
ACCURACY=$(python3 -c "print(f'{${PASS}/${TOTAL}*100:.1f}%')" 2>/dev/null || echo "N/A")
echo " Accuracy: ${ACCURACY}"
echo "==========================================="

# Exit with non-zero if accuracy below 75%
THRESHOLD=75
ACTUAL=$(python3 -c "print(int(${PASS}/${TOTAL}*100))" 2>/dev/null || echo "0")
if [ "$ACTUAL" -lt "$THRESHOLD" ]; then
  echo " WARNING: Accuracy ${ACCURACY} is below ${THRESHOLD}% threshold"
  exit 1
fi

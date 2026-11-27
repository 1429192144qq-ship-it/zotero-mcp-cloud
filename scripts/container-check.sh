#!/usr/bin/env bash
# Container smoke test for the authenticated HTTP image.
#
#   bash scripts/container-check.sh <image> [host-port]
#
# Uses only a throwaway random token and a placeholder Zotero key. No check
# calls a tool that would contact Zotero, so no real credentials are needed
# or used. Runs the container with host networking and PORT=<host-port>.
set -euo pipefail

IMAGE="${1:?usage: container-check.sh <image> [host-port]}"
PORT="${2:-3999}"
NAME="zotero-mcp-check-$$"
BASE="http://127.0.0.1:${PORT}"
PLACEHOLDER_ENV=(-e ZOTERO_API_KEY=ci-placeholder-not-a-key -e ZOTERO_LIBRARY_ID=0)
CURL=(curl -sS --noproxy '*' --max-time 10)
ACCEPT="Accept: application/json, text/event-stream"
JSON="Content-Type: application/json"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"container-check","version":"0"}}}'

fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }
pass() { echo "ok - $*"; }
cleanup() { docker rm -f "$NAME" "$NAME-noauth" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Print the JSON payload of the first SSE "data:" line (or a plain JSON body).
sse_json() { python3 -c 'import sys
body = sys.stdin.read()
lines = [l[5:].strip() for l in body.splitlines() if l.startswith("data:")]
print(lines[0] if lines else body.strip())'; }

# 1. Missing authentication configuration: the container must refuse to start.
#    The timeout turns "started anyway and kept running" into a failure.
set +e
out="$(timeout 30 docker run --rm --name "$NAME-noauth" --network host \
  "${PLACEHOLDER_ENV[@]}" -e PORT="$PORT" "$IMAGE" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "container started without MCP_AUTH_TOKEN_HASHES"
grep -q "refusing to start the HTTP transport without authentication" <<<"$out" \
  || fail "unexpected startup error: $out"
pass "refuses to start without authentication config (exit $status)"

# 2. Throwaway test credentials.
TOKEN="$(openssl rand -hex 32)"
WRONG="$(openssl rand -hex 32)"
HASH="$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$TOKEN"; echo "::add-mask::$WRONG"; fi

docker run -d --name "$NAME" --network host "${PLACEHOLDER_ENV[@]}" \
  -e PORT="$PORT" -e MCP_AUTH_TOKEN_HASHES="ci:${HASH}:ro" "$IMAGE" >/dev/null

# 3. Docker HEALTHCHECK (as defined in the image) must report healthy.
health=""
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "container exited"
  health="$(docker inspect -f '{{.State.Health.Status}}' "$NAME")"
  [ "$health" = "healthy" ] && break
  sleep 2
done
[ "$health" = "healthy" ] || fail "HEALTHCHECK status: $health"
pass "starts with test config; HEALTHCHECK healthy"
docker logs "$NAME" 2>&1 | grep -q "authenticated HTTP .*write=disabled" || fail "startup log"
pass "startup log reports authenticated HTTP, write=disabled"

[ "$("${CURL[@]}" "$BASE/healthz")" = "ok" ] || fail "/healthz body"
pass "/healthz returns ok"

# 4. Unauthenticated and wrongly authenticated requests get 401.
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "$JSON" -H "$ACCEPT" -d "$INIT")"
[ "$code" = "401" ] || fail "unauthenticated initialize returned $code"
www="$("${CURL[@]}" -o /dev/null -D - -X POST "$BASE/mcp" -H "$JSON" -H "$ACCEPT" -d "$INIT" | tr -d '\r' | grep -i '^www-authenticate:' || true)"
[ -n "$www" ] || fail "401 without WWW-Authenticate"
pass "unauthenticated /mcp request returns 401 with WWW-Authenticate"

code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "$JSON" -H "$ACCEPT" \
  -H "Authorization: Bearer $WRONG" -d "$INIT")"
[ "$code" = "401" ] || fail "wrong token returned $code"
pass "wrong token returns 401"

code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "$JSON" -H "$ACCEPT" \
  -H "Authorization: Bearer $TOKEN" -H "Authorization: Bearer $WRONG" -d "$INIT")"
[ "$code" = "401" ] || fail "duplicate Authorization headers returned $code"
pass "duplicate Authorization headers return 401"

# 5. Valid token: session opens, read tools listed, write tools absent.
headers="$("${CURL[@]}" -o /dev/null -D - -X POST "$BASE/mcp" -H "$JSON" -H "$ACCEPT" \
  -H "Authorization: Bearer $TOKEN" -d "$INIT" | tr -d '\r')"
grep -q '^HTTP/1.1 200' <<<"$headers" || fail "authenticated initialize: $(head -1 <<<"$headers")"
SID="$(grep -i '^mcp-session-id:' <<<"$headers" | cut -d' ' -f2)"
[ -n "$SID" ] || fail "no session id"
pass "valid token opens a session"

AUTH=(-H "$JSON" -H "$ACCEPT" -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SID" -H "mcp-protocol-version: 2025-03-26")
"${CURL[@]}" -o /dev/null -X POST "$BASE/mcp" "${AUTH[@]}" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

tools="$("${CURL[@]}" -X POST "$BASE/mcp" "${AUTH[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | sse_json | python3 -c 'import json,sys; print(" ".join(sorted(t["name"] for t in json.load(sys.stdin)["result"]["tools"])))')"
[ "$tools" = "get_item get_item_attachments get_item_fulltext list_collections read_attachment read_pdf search_items" ] \
  || fail "unexpected tool list: $tools"
pass "read-only tool list: $tools"

call="$("${CURL[@]}" -X POST "$BASE/mcp" "${AUTH[@]}" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"x","content":"<p>x</p>"}}}' | sse_json)"
python3 -c 'import json,sys
r = json.loads(sys.argv[1])
refused = "error" in r or (r.get("result", {}).get("isError") is True)
sys.exit(0 if refused else 1)' "$call" || fail "create_note was not refused: $call"
pass "write tool create_note is refused in read-only mode"

# 6. The token must never appear in container logs.
if docker logs "$NAME" 2>&1 | grep -qF "$TOKEN"; then fail "token found in logs"; fi
pass "token absent from container logs"

echo "All container checks passed."

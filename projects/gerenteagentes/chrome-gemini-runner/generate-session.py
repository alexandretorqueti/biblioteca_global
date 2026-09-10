#!/usr/bin/env python3
"""
Gera gemini-session.json a partir da captura completa
Usa o payload capturado como TEMPLATE (mais robusto que reconstruir)
"""

import json
import urllib.parse

# Carregar captura completa (request + response + headers + cookies)
with open("/tmp/gemini-full-request.json") as f:
    capture = json.load(f)

req = capture[0]

# Parsear URL
url = req["url"]
query = urllib.parse.urlparse(url).query
params = urllib.parse.parse_qs(query)

# Parsear postData
post_data = req["postData"]
form = urllib.parse.parse_qs(post_data)
f_req = json.loads(form["f.req"][0])
at_token = form["at"][0]

# O template é o segundo elemento do f.req (string JSON)
template = json.loads(f_req[1])

# Extrair cookies dos headers
cookies = req["headers"].get("cookie") or req["headers"].get("Cookie", "")

# Headers especiais x-goog-ext
goog_headers = {}
for k, v in req["headers"].items():
    if k.lower().startswith("x-goog-ext"):
        goog_headers[k] = v

session = {
    "provider": "gemini",
    "capturedAt": req["timestamp"],
    "url": "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    "bl": params.get("bl", [""])[0],
    "fsid": params.get("f.sid", [""])[0],
    "hl": params.get("hl", ["pt"])[0],
    "at": at_token,
    "cookies": cookies,
    "googHeaders": goog_headers,
    "userAgent": req["headers"].get("User-Agent") or req["headers"].get("user-agent", ""),
    "template": template,
}

with open("/app/gemini-session.json", "w") as f:
    json.dump(session, f, indent=2)

print("✅ gemini-session.json gerado!")
print(f"   URL: {session['url']}")
print(f"   bl: {session['bl']}")
print(f"   f.sid: {session['fsid']}")
print(f"   at: {session['at'][:40]}...")
print(f"   cookies: {len(session['cookies'])} bytes")
print(f"   googHeaders: {list(session['googHeaders'].keys())}")
print(f"   template: {len(template)} posições")
print(f"   template[0][0] (mensagem): {template[0][0]!r}")
print(f"   template[2][0:3] (IDs): {template[2][0:3]}")

#!/usr/bin/env python3
"""Verifica os cookies críticos na sessão"""

import json

with open("/app/gemini-session.json") as f:
    session = json.load(f)

cookies = session["cookies"]
names = [c.split("=")[0].strip() for c in cookies.split(";")]

print("🍪 Cookies na sessão:")
for n in names:
    print(f"   - {n}")

critical = ["__Secure-1PSID", "SID", "HSID", "SSID", "APISID", "SAPISID", 
            "__Secure-1PAPISID", "__Secure-3PSID", "NID", "SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC"]

print()
print("🔐 Cookies críticos:")
for c in critical:
    status = "OK" if c in names else "AUSENTE"
    print(f"   {c}: {status}")

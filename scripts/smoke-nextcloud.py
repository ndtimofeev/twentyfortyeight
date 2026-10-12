#!/usr/bin/env python3
"""Exercise the installed app using ordinary Nextcloud login and CSRF checks."""
import html.parser
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


class TokenParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.token = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "data-requesttoken" in attrs:
            self.token = attrs["data-requesttoken"]
        if tag == "input" and attrs.get("name") == "requesttoken":
            self.token = attrs.get("value")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")
        parsed = urllib.parse.urlparse(self.base)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("Smoke tests only accept an isolated localhost instance")
        jar = http.cookiejar.CookieJar()
        # Local Docker traffic must not pass through a remote HTTP proxy.
        self.browser = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar)
        )
        self.api = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar), NoRedirect()
        )
        self.token = None

    def login(self, user, password):
        with self.browser.open(self.base + "/index.php/login", timeout=30) as response:
            parser = TokenParser()
            parser.feed(response.read().decode())
        assert parser.token, "Login page did not expose a CSRF token"
        form = urllib.parse.urlencode({
            "user": user, "password": password, "requesttoken": parser.token,
            "redirect_url": "/index.php/apps/twentyfortyeight/",
        }).encode()
        request = urllib.request.Request(self.base + "/index.php/login", data=form, headers={
            "Origin": self.base,
            "Content-Type": "application/x-www-form-urlencoded",
        })
        with self.browser.open(request, timeout=30) as response:
            response.read()
            assert "/apps/twentyfortyeight" in response.url, "Nextcloud rejected the login form"
        with self.browser.open(self.base + "/index.php/apps/twentyfortyeight/", timeout=30) as response:
            assert "/apps/twentyfortyeight" in response.url, "Nextcloud login failed"
            parser = TokenParser()
            parser.feed(response.read().decode())
        assert parser.token, "App page did not expose a CSRF token"
        self.token = parser.token

    def request(self, path, payload=None, expected=200, csrf=True):
        headers = {"Accept": "application/json", "X-Requested-With": "XMLHttpRequest", "Origin": self.base}
        if csrf and self.token:
            headers["requesttoken"] = self.token
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + "/index.php/apps/twentyfortyeight" + path,
                                         data=data, headers=headers)
        try:
            response = self.api.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read().decode()
            status = response.status
        assert status == expected, f"{path}: expected HTTP {expected}, got {status}: {body[:500]}"
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            assert expected != 200, f"{path}: successful API response was not JSON"
            return None


def main():
    password = os.environ["TEST_NEXTCLOUD_PASSWORD"]
    one, two = Client(sys.argv[1]), Client(sys.argv[1])
    one.login("smoke-one", password)
    two.login("smoke-two", password)
    assert one.request("/api/scores")["me"] is None
    one.request("/api/games", {}, expected=412, csrf=False)

    session = one.request("/api/games", {})
    assert session["version"] == 1 and 1 <= session["seed"] <= 0xFFFFFFFF
    assert isinstance(session["token"], str) and "." in session["token"]
    forged = {"session": "", "actions": [], "score": 999999, "bestTile": 131072, "moves": 1}
    one.request("/api/scores", forged, expected=400)
    # Claimed statistics never replace the result of the server replay.
    empty = {**forged, "session": session["token"]}
    result = one.request("/api/scores", empty)
    assert result["me"]["score"] == 0 and result["me"]["bestTile"] in (2, 4)

    token = session["token"]
    encoded, signature = token.split(".")
    altered = encoded + "." + ("A" if signature[0] != "A" else "B") + signature[1:]
    one.request("/api/scores", {"session": altered, "actions": []}, expected=400)
    two.request("/api/scores", {"session": token, "actions": []}, expected=400)
    one.request("/api/scores", {"session": token, "actions": [["invented-action"]]}, expected=400)

    second = two.request("/api/games", {})
    result = two.request("/api/scores", {"session": second["token"], "actions": []})
    assert len(result["leaderboard"]) == 2
    assert all(entry["rank"] == 1 and entry["score"] == 0 for entry in result["leaderboard"])
    assert result["me"]["rank"] == 1

    proof = json.loads(subprocess.check_output(
        ["node", str(Path(__file__).with_name("generate-proof.js")), json.dumps(session)], text=True
    ))
    assert proof["actions"] and proof["expected"]["score"] > 0
    payload = {"session": token, "actions": proof["actions"]}
    result = one.request("/api/scores", payload)
    for key in ("score", "bestTile"):
        assert result["me"][key] == proof["expected"][key], (key, result, proof)
    assert result["me"]["rank"] == 1
    assert result["leaderboard"][1]["rank"] == 2
    # Repeating a valid submission is harmless, and an older prefix cannot lower records.
    assert one.request("/api/scores", payload)["me"] == result["me"]
    assert one.request("/api/scores", empty)["me"] == result["me"]
    print("Login, CSRF, signed sessions, replay, rejected forgery, shared ranks and record preservation passed.")


if __name__ == "__main__":
    main()

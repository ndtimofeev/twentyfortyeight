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

    def request(self, path, payload=None, expected=200, csrf=True, method=None):
        headers = {"Accept": "application/json", "X-Requested-With": "XMLHttpRequest", "Origin": self.base}
        if csrf and self.token:
            headers["requesttoken"] = self.token
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + "/index.php/apps/twentyfortyeight" + path,
                                         data=data, headers=headers, method=method)
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
    assert one.request("/api/games")["game"] is None
    assert two.request("/api/games")["game"] is None
    one.request("/api/games", {}, expected=412, csrf=False)

    initial = one.request("/api/games", {})["game"]
    assert one.request("/api/games", {})["game"] == initial, "Opening the game restarted the active party"
    assert one.request("/api/games")["game"] == initial
    assert isinstance(initial["revision"], int) and initial["actions"] == []
    session = initial["session"]
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

    second = two.request("/api/games", {})["game"]["session"]
    assert second["token"] != token
    assert one.request("/api/games")["game"] == initial, "Another user's game changed this user's board"
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

    # Persist a verified history through an optimistic, per-user game revision.
    two.request("/api/games", {
        "session": token, "actions": [], "revision": initial["revision"],
    }, expected=400, method="PUT")
    assert two.request("/api/games")["game"]["session"] == second
    prefix = {"session": token, "actions": proof["actions"][:1], "revision": initial["revision"]}
    partial = one.request("/api/games", prefix, method="PUT")["game"]
    assert partial["actions"] == prefix["actions"] and partial["revision"] > initial["revision"]
    stale = {**payload, "revision": initial["revision"]}
    assert one.request("/api/games", stale, expected=409, method="PUT")["game"] == partial
    active = one.request("/api/games", {**payload, "revision": partial["revision"]}, method="PUT")["game"]
    assert active["actions"] == proof["actions"] and active["session"] == session
    assert active["state"]["score"] == proof["expected"]["score"]
    assert active["state"]["maxTile"] == proof["expected"]["bestTile"]
    assert 1 <= active["state"]["randomState"] <= 0xFFFFFFFF
    for field in ("grid", "bonuses", "reached", "previous", "over", "won", "keepPlaying", "moves"):
        assert field in active["state"], f"The saved board omitted {field}"
    assert one.request("/api/games")["game"] == active
    assert one.request("/api/games", {})["game"] == active
    assert one.request("/api/games", {**payload, "revision": initial["revision"]}, method="PUT")["game"] == active

    # Use a different legal opening move to prove that a divergent history is rejected.
    cells = initial["state"]["grid"]["cells"]
    vectors = ((0, -1), (1, 0), (0, 1), (-1, 0))
    divergent_direction = None
    for direction, (dx, dy) in enumerate(vectors):
        if direction == proof["actions"][0][1]:
            continue
        if any(cells[x][y] and 0 <= x + dx < 4 and 0 <= y + dy < 4
               and (not cells[x + dx][y + dy] or cells[x + dx][y + dy]["value"] == cells[x][y]["value"])
               for x in range(4) for y in range(4)):
            divergent_direction = direction
            break
    assert divergent_direction is not None
    divergent = {"session": token, "actions": [["move", divergent_direction]], "revision": active["revision"]}
    assert one.request("/api/games", divergent, expected=409, method="PUT")["game"] == active
    assert one.request("/api/games")["game"] == active

    restarted = one.request("/api/games", {"restart": True})["game"]
    assert restarted["session"]["token"] != token and restarted["actions"] == []
    assert restarted["state"]["score"] == 0
    assert one.request("/api/games", {**payload, "revision": active["revision"]}, expected=409, method="PUT")["game"] == restarted
    assert two.request("/api/games")["game"]["session"] == second
    print("Login, CSRF, signed replay, rejected forgery, shared ranks, active game restore, user isolation and optimistic conflicts passed.")


if __name__ == "__main__":
    main()

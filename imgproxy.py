#!/usr/bin/env python3
"""Tiny image proxy for appliance-budget-picker.
CF Workers can't fetch retailer CDN images (blocked), but this VPS can reach most of them.
Endpoints:
  GET /img?url=<encoded_url>  — proxy the image (caches to disk)
  GET /verify?url=<encoded_url> — return {"ok":true/false, "url":"...", "ct":"..."}
  GET /page?url=<encoded_url> — return fetched retailer HTML for parser evidence
"""
import hashlib, os, asyncio, shlex
from pathlib import Path
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CACHE_DIR = Path("/tmp/imgproxy-cache")
CACHE_DIR.mkdir(exist_ok=True)

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
}
IMAGE_HEADERS = {**BASE_HEADERS, "Accept": "image/*,*/*;q=0.8"}
HTML_HEADERS = {**BASE_HEADERS, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
DENIAL_MARKERS = ("Access to this page has been denied", "px-captcha")
MAX_HTML_BYTES = 350_000

async def fetch_image(url: str) -> tuple[bytes | None, str]:
    """Fetch image, return (bytes, content_type) or (None, '')."""
    cache_key = hashlib.sha256(url.encode()).hexdigest()[:16]
    cache_path = CACHE_DIR / cache_key

    # Check disk cache
    meta_path = CACHE_DIR / f"{cache_key}.ct"
    if cache_path.exists() and meta_path.exists():
        return cache_path.read_bytes(), meta_path.read_text()

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(url, headers=IMAGE_HEADERS)
            ct = resp.headers.get("content-type", "").lower()
            if resp.status_code == 200 and ct.startswith("image/") and len(resp.content) > 1000:
                cache_path.write_bytes(resp.content)
                meta_path.write_text(ct)
                return resp.content, ct
    except Exception:
        pass
    return None, ""


def usable_html(text: str) -> bool:
    return bool(text) and not any(marker in text for marker in DENIAL_MARKERS)


def page_cache_paths(url: str) -> tuple[Path, Path]:
    cache_key = hashlib.sha256(("page:" + url).encode()).hexdigest()[:16]
    return CACHE_DIR / f"{cache_key}.html", CACHE_DIR / f"{cache_key}.url"


def read_cached_page(url: str) -> dict | None:
    html_path, meta_path = page_cache_paths(url)
    if html_path.exists() and meta_path.exists():
        html = html_path.read_text(errors="replace")[:MAX_HTML_BYTES]
        if usable_html(html):
            return {"ok": True, "url": url, "finalUrl": meta_path.read_text().strip() or url, "status": 200, "via": "cache", "html": html}
    return None


def write_cached_page(url: str, final_url: str, html: str) -> None:
    if not usable_html(html):
        return
    html_path, meta_path = page_cache_paths(url)
    html_path.write_text(html[:MAX_HTML_BYTES])
    meta_path.write_text(final_url or url)


async def fetch_page_direct(url: str) -> dict:
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(url, headers=HTML_HEADERS)
            ct = resp.headers.get("content-type", "").lower()
            html = resp.text[:MAX_HTML_BYTES] if "text/html" in ct else ""
            if resp.status_code == 200 and "text/html" in ct and usable_html(html):
                write_cached_page(url, str(resp.url), html)
                return {"ok": True, "url": url, "finalUrl": str(resp.url), "status": resp.status_code, "via": "vps", "html": html}
            return {"ok": False, "url": url, "status": resp.status_code, "ct": ct, "blocked": bool(html and not usable_html(html))}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}


async def fetch_page_macstudio(url: str) -> dict:
    try:
        remote_cmd = " ".join([
            "/usr/bin/curl", "-LfsS", "--max-time", "20",
            "-A", shlex.quote("Mozilla/5.0"),
            "-H", shlex.quote("Accept: text/html,*/*"),
            shlex.quote(url),
        ])
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
            "macstudio", remote_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        html = stdout.decode("utf-8", errors="replace")[:MAX_HTML_BYTES]
        if proc.returncode == 0 and usable_html(html):
            write_cached_page(url, url, html)
            return {"ok": True, "url": url, "finalUrl": url, "status": 200, "via": "macstudio", "html": html}
        return {"ok": False, "url": url, "via": "macstudio", "status": proc.returncode, "error": stderr.decode("utf-8", errors="replace")[-500:]}
    except Exception as exc:
        return {"ok": False, "url": url, "via": "macstudio", "error": str(exc)}


@app.get("/page")
async def page(url: str = Query(...)):
    cached = read_cached_page(url)
    if cached:
        return cached
    direct = await fetch_page_direct(url)
    if direct.get("ok"):
        return direct
    mac = await fetch_page_macstudio(url)
    if mac.get("ok"):
        mac["fallbackFrom"] = direct
        return mac
    return {"ok": False, "url": url, "direct": direct, "macstudio": mac}


@app.get("/verify")
async def verify(url: str = Query(...)):
    data, ct = await fetch_image(url)
    if data:
        return {"ok": True, "url": url, "ct": ct, "size": len(data)}
    return {"ok": False, "url": url}


@app.get("/img")
async def proxy(url: str = Query(...)):
    data, ct = await fetch_image(url)
    if data:
        return Response(content=data, media_type=ct, headers={
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        })
    return Response(status_code=404, content="Image not found")

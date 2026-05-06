#!/usr/bin/env python3
"""Tiny image proxy for appliance-budget-picker.
CF Workers can't fetch retailer CDN images (blocked), but this VPS can reach most of them.
Endpoints:
  GET /img?url=<encoded_url>  — proxy the image (caches to disk)
  GET /verify?url=<encoded_url> — return {"ok":true/false, "url":"...", "ct":"..."}
  GET /page?url=<encoded_url> — return fetched retailer HTML for parser evidence
"""
import hashlib, os, asyncio
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


@app.get("/page")
async def page(url: str = Query(...)):
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(url, headers=HTML_HEADERS)
            ct = resp.headers.get("content-type", "").lower()
            if resp.status_code == 200 and "text/html" in ct:
                return {
                    "ok": True,
                    "url": url,
                    "finalUrl": str(resp.url),
                    "status": resp.status_code,
                    "html": resp.text[:1500000],
                }
            return {"ok": False, "url": url, "status": resp.status_code, "ct": ct}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}


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

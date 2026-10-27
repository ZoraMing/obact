import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright
from obact import snapshot

async def main(url, out):
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=False)
        p = await (await b.new_context(viewport={"width": 1280, "height": 800})).new_page()
        await p.goto(url)
        s = await snapshot.take(p)
        Path(out).write_bytes(s.image)
        print(p.url)
        print(s.text[:6000])
        await b.close()
asyncio.run(main(sys.argv[1], sys.argv[2]))
# python.exe look.py "https://flights.ctrip.com/online/channel/domestic" tmp.png
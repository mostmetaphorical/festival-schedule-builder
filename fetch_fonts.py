"""Download the app's three typefaces so the page never has to ask Google.

Loading fonts from fonts.googleapis.com would hand every visitor's IP address
to Google on each page load, which is at odds with an app that promises
nothing leaves the device. All three are under the SIL Open Font License,
which allows redistribution alongside the licence text, so they are served
from app/fonts/ instead.

    python fetch_fonts.py

Only the Latin subsets are kept: the app's own text is English, and film
titles in other scripts fall back to the system font.
"""

from __future__ import annotations

import re
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "app" / "fonts"
# Google serves woff2 only to browsers that say they can read it.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
FAMILIES = {
    "Anton": ("family=Anton", "anton"),
    "Inter": ("family=Inter:wght@400;600;700;800", "inter"),
    "Space Mono": ("family=Space+Mono:wght@400;700", "spacemono"),
}
LICENCES = {
    "anton": "https://raw.githubusercontent.com/google/fonts/main/ofl/anton/OFL.txt",
    "inter": "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt",
    "spacemono": "https://raw.githubusercontent.com/google/fonts/main/ofl/spacemono/OFL.txt",
}
BLOCK = re.compile(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*{[^}]*})")


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.woff2"):
        old.unlink()
    rules: list[str] = []
    # Inter is one variable font: every weight points at the same file.
    saved: dict[str, str] = {}
    for family, (query, slug) in FAMILIES.items():
        css = get(f"https://fonts.googleapis.com/css2?{query}&display=swap").decode("utf-8")
        for subset, block in BLOCK.findall(css):
            if subset != "latin":
                continue
            url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
            weight = re.search(r"font-weight:\s*([\d ]+);", block).group(1).strip()
            style = re.search(r"font-style:\s*(\w+);", block).group(1)
            if url not in saved:
                saved[url] = f"{slug}-{weight.replace(' ', '-')}-{style}.woff2"
                (OUT / saved[url]).write_bytes(get(url))
            name = saved[url]
            # Several weights of a variable font share one file; point at it once.
            rule = re.sub(r"url\([^)]+\)", f"url({name})", block)
            if rule not in rules:
                rules.append(f"/* {family}, {subset} */\n{rule}")
        (OUT / f"OFL-{slug}.txt").write_bytes(get(LICENCES[slug]))

    header = (
        "/* Anton, Inter and Space Mono, served from this site rather than Google.\n"
        "   Each is under the SIL Open Font License 1.1 - see the OFL-*.txt files. */\n\n"
    )
    (OUT / "fonts.css").write_text(header + "\n\n".join(dict.fromkeys(rules)) + "\n", encoding="utf-8")
    for file in sorted(OUT.iterdir()):
        print(f"  {file.name:40} {file.stat().st_size / 1024:7.1f} KB")


if __name__ == "__main__":
    main()

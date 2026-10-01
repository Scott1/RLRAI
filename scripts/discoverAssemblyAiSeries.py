"""Snapshot the published RLR series and cross-check its episodes against RSS."""

import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path

from bs4 import BeautifulSoup

SITE = "https://www.realloveready.com"
FEED = "https://feeds.megaphone.fm/SBP3892967148"
SHARED_SURNAME = {"ashley-lair-torrent": ["Ashley Torrent", "Lair Torrent"]}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "RLR-Series-Inventory/0.1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def save(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def normalized(text):
    return re.sub(r"[^a-z0-9]", "", unescape(text).casefold())


def duration(text):
    parts = [float(part) for part in text.split(":")]
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + part
    if seconds <= 0 or len(parts) > 3:
        raise ValueError("Invalid feed duration")
    return seconds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".rlr/assemblyai-series")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    snapshots = root / "discovery"
    snapshots.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    feed_bytes = fetch(FEED)
    (snapshots / "podcast-feed.xml").write_bytes(feed_bytes)
    feed_items = ET.fromstring(feed_bytes).findall("./channel/item")
    pages = {}
    url = SITE + "/real-love-ready-series?format=json"
    visited = set()
    while url:
        if url in visited or len(visited) >= 20:
            raise ValueError("Repeated or excessive collection pagination")
        visited.add(url)
        data = fetch(url)
        (snapshots / f"index-page-{len(visited):02d}.json").write_bytes(data)
        page = json.loads(data)
        for item in page.get("items", []):
            full_url = urllib.parse.urljoin(SITE, item.get("fullUrl", ""))
            parsed = urllib.parse.urlsplit(full_url)
            if parsed.netloc != "www.realloveready.com" or not re.fullmatch(r"/real-love-ready-series/[a-z0-9-]+", parsed.path):
                raise ValueError("Unexpected episode URL in collection")
            pages[full_url] = item
        pagination = page.get("pagination", {})
        if not pagination.get("nextPage"):
            url = None
        else:
            next_url = urllib.parse.urljoin(SITE, pagination["nextPageUrl"])
            parsed = urllib.parse.urlsplit(next_url)
            if parsed.netloc != "www.realloveready.com" or parsed.path != "/real-love-ready-series":
                raise ValueError("Unexpected pagination URL")
            query = dict(urllib.parse.parse_qsl(parsed.query))
            query["format"] = "json"
            url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))

    episodes, blocked, used_pages = [], [], set()
    itunes = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
    for entry in feed_items:
        feed_title = unescape(entry.findtext("title", ""))
        number_match = re.search(r"\|\s*Real Love Ready Ep\.?\s*0*(\d+)\b", feed_title, re.I)
        if not number_match:
            continue
        pub_date = entry.findtext("pubDate", "")
        published = parsedate_to_datetime(pub_date)
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        if published > now:
            continue
        number = int(number_match[1])
        name_match = re.match(r"^(.+?)\s+[\-\u2013\u2014]\s+", feed_title)
        if not name_match:
            blocked.append({"feed_title": feed_title, "reason": "Cannot determine guest names from RSS title"})
            continue
        guest_label = name_match[1].strip()
        candidates = [page_url for page_url, item in pages.items()
                      if normalized(guest_label) in normalized(item.get("title", ""))]
        if len(candidates) != 1:
            blocked.append({"feed_title": feed_title, "reason": f"Expected one website match; found {len(candidates)}"})
            continue
        page_url = candidates[0]
        if page_url in used_pages:
            raise ValueError("Multiple feed entries match one episode page")
        used_pages.add(page_url)
        slug = urllib.parse.urlsplit(page_url).path.rsplit("/", 1)[1]
        page_bytes = fetch(page_url + "?format=json")
        raw = root / "raw" / slug
        raw.mkdir(parents=True, exist_ok=True)
        (raw / "episode-page.json").write_bytes(page_bytes)
        item = json.loads(page_bytes)["item"]
        body = BeautifulSoup(item.get("body", ""), "html.parser")
        text = body.get_text("\n", strip=True)
        (raw / "episode-page-text.txt").write_text(text, encoding="utf-8")
        guests = SHARED_SURNAME.get(slug, [name.strip() for name in guest_label.split(" & ")])
        # Names must agree with official episode copy, not just a historical spreadsheet.
        searchable = normalized(unescape(item.get("title", "")) + " " + text)
        if "robin" not in searchable or any(normalized(name) not in searchable for name in guests):
            blocked.append({"feed_title": feed_title, "page_url": page_url, "reason": "Participant names need manual confirmation"})
            continue
        if len(guests) not in (1, 2) or len(set(guests)) != len(guests):
            blocked.append({"feed_title": feed_title, "reason": "Unexpected guest count"})
            continue
        enclosure = entry.find("enclosure")
        if enclosure is None or not enclosure.get("url", "").startswith("https://"):
            blocked.append({"feed_title": feed_title, "reason": "No HTTPS audio enclosure"})
            continue
        metadata = {
            "slug": slug, "episode_number": number,
            "title": unescape(item.get("title", "")), "series": "Real Love Ready: The Series",
            "host": "Robin Ducharme", "guests": guests, "speakers_expected": 1 + len(guests),
            "participant_evidence": "RSS guest names cross-checked with official episode-page copy; interview voices only, excludes ads",
            "page_url": page_url, "feed_url": FEED, "feed_guid": entry.findtext("guid"),
            "feed_title": feed_title, "publication_date": pub_date,
            "audio_url": enclosure.get("url"), "audio_type": enclosure.get("type"),
            "feed_duration_seconds": duration(entry.findtext(itunes + "duration", "")),
            "page_sha256": hashlib.sha256(page_bytes).hexdigest(),
            "rights_status": "review_required", "timestamp_basis": "downloaded podcast audio; not verified against YouTube",
        }
        if re.search(r"audience\s+(?:questions|q\s*&\s*a)|\bq\s*&\s*a\b", text, re.I):
            metadata["speaker_count_review_required"] = True
            metadata["speaker_count_notes"] = "Episode copy mentions audience Q&A; named interview participants do not cover every conversation voice."
        save(raw / "source.json", metadata)
        episodes.append(metadata)
        print(f"Matched episode {number:02d}: {slug}, {metadata['speakers_expected']} interview speakers", flush=True)
    for page_url in pages.keys() - used_pages:
        blocked.append({"page_url": page_url, "title": unescape(pages[page_url].get("title", "")),
                        "reason": "Website episode has no uniquely matched published series RSS recording"})
    episodes.sort(key=lambda item: item["episode_number"])
    if len({item["episode_number"] for item in episodes}) != len(episodes):
        raise ValueError("Duplicate episode numbers")
    inventory = {"schema_version": 1, "discovered_at": now.isoformat(), "series_url": SITE + "/real-love-ready-series",
                 "feed_url": FEED, "collection_pages": len(visited), "episodes": episodes, "blocked": blocked}
    save(root / "source-inventory.json", inventory)
    print(f"Saved {len(episodes)} published episodes, {len(blocked)} items needing review.", flush=True)


if __name__ == "__main__":
    main()

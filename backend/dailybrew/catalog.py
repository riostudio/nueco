from dataclasses import dataclass, field


@dataclass(frozen=True)
class Outlet:
    id: str
    name: str
    description: str
    feed_url: str
    # Loose content tags used by /dailybrew/search-feeds (e.g. "AI", "Technology") - not
    # shown for country-catalog outlets unless they happen to also cover a topic.
    topics: list[str] = field(default_factory=list)


# Curated per-country outlet lists, keyed by ISO 3166-1 alpha-2 country code. This is the
# server-owned source of truth (not duplicated in the frontend) so adding a country or fixing
# a stale feed URL is a content change here, not a client release.
#
# Every feed_url below was verified with a live GET (returning parseable RSS/Atom with
# item/entry elements) at implementation time. A few outlets named in the original spec
# turned out to be dead ends and were substituted or dropped - see the module docstring in
# service.py's fetch path, and the implementation notes in the PR/report for specifics:
#   - AU: news.com.au (feed endpoints return HTTP 200 with an empty body - content
#     negotiation appears to require a browser context) and 9News (all guessed /rss paths
#     serve the client-rendered HTML app shell, no discoverable feed) were dropped in favor
#     of the Sydney Morning Herald, which has a working feed.
#   - ID: Kompas.com's public RSS feeds appear to have been discontinued (robots.txt has no
#     feed reference, every guessed path 404s) and was dropped.
OUTLET_CATALOG: dict[str, list[Outlet]] = {
    "AU": [
        Outlet(
            id="abc-news-au",
            name="ABC News Australia",
            description="Australia's national public broadcaster.",
            feed_url="https://www.abc.net.au/news/feed/51120/rss.xml",
        ),
        Outlet(
            id="guardian-au",
            name="The Guardian Australia",
            description="Australian edition of the UK-based Guardian.",
            feed_url="https://www.theguardian.com/au/rss",
        ),
        Outlet(
            id="sbs-news",
            name="SBS News",
            description="Australia's multicultural and multilingual broadcaster.",
            feed_url="https://www.sbs.com.au/news/topic/latest/feed",
        ),
        Outlet(
            id="smh",
            name="Sydney Morning Herald",
            description="Major daily newspaper based in Sydney.",
            feed_url="https://www.smh.com.au/rss/feed.xml",
        ),
    ],
    "ID": [
        Outlet(
            id="detik-news",
            name="Detik.com",
            description="One of Indonesia's most-visited news portals.",
            feed_url="https://news.detik.com/rss",
        ),
        Outlet(
            id="antara-news",
            name="Antara News",
            description="Indonesia's national news agency.",
            feed_url="https://www.antaranews.com/rss/terkini.xml",
        ),
        Outlet(
            id="cnn-indonesia",
            name="CNN Indonesia",
            description="Indonesian-language CNN affiliate.",
            feed_url="https://www.cnnindonesia.com/rss",
        ),
        Outlet(
            id="tribunnews",
            name="Tribunnews.com",
            description="Indonesia's largest regional news network.",
            feed_url="https://www.tribunnews.com/rss",
        ),
    ],
}

# Topic-focused feeds, not scoped to a country - surfaced via /dailybrew/search-feeds when a
# user searches something like "AI" or "food" in the News from home picker. Kept intentionally
# small: only outlets with a verified, working public RSS/Atom feed are included, so some
# topics have just one or two entries rather than a padded-out five.
TOPIC_FEED_POOL: list[Outlet] = [
    Outlet(
        id="techcrunch-ai",
        name="TechCrunch AI",
        description="TechCrunch's artificial intelligence coverage.",
        feed_url="https://techcrunch.com/category/artificial-intelligence/feed/",
        topics=["AI", "Technology"],
    ),
    Outlet(
        id="venturebeat-ai",
        name="VentureBeat AI",
        description="VentureBeat's AI section.",
        feed_url="https://venturebeat.com/category/ai/feed/",
        topics=["AI", "Technology"],
    ),
    Outlet(
        id="the-verge",
        name="The Verge",
        description="Technology, science, and culture news.",
        feed_url="https://www.theverge.com/rss/index.xml",
        topics=["Technology"],
    ),
    Outlet(
        id="ars-technica",
        name="Ars Technica",
        description="In-depth technology news and analysis.",
        feed_url="https://feeds.arstechnica.com/arstechnica/index",
        topics=["Technology"],
    ),
    Outlet(
        id="bbc-world",
        name="BBC World News",
        description="BBC's international news coverage.",
        feed_url="http://feeds.bbci.co.uk/news/world/rss.xml",
        topics=["World"],
    ),
    Outlet(
        id="al-jazeera",
        name="Al Jazeera",
        description="Global news from the Qatar-based broadcaster.",
        feed_url="https://www.aljazeera.com/xml/rss/all.xml",
        topics=["World"],
    ),
    Outlet(
        id="cnbc-business",
        name="CNBC Business",
        description="Business and markets news from CNBC.",
        feed_url="https://www.cnbc.com/id/10001147/device/rss/rss.html",
        topics=["Business", "Finance"],
    ),
    Outlet(
        id="marketwatch",
        name="MarketWatch",
        description="Financial markets news and analysis.",
        feed_url="http://feeds.marketwatch.com/marketwatch/topstories/",
        topics=["Business", "Finance"],
    ),
    Outlet(
        id="bbc-sport",
        name="BBC Sport",
        description="BBC's sport coverage.",
        feed_url="http://feeds.bbci.co.uk/sport/rss.xml?edition=uk",
        topics=["Sports"],
    ),
    Outlet(
        id="npr-health",
        name="NPR Health",
        description="Health and medicine coverage from NPR.",
        feed_url="https://feeds.npr.org/1128/rss.xml",
        topics=["Health"],
    ),
    Outlet(
        id="cnn-health",
        name="CNN Health",
        description="Health news from CNN.",
        feed_url="http://rss.cnn.com/rss/cnn_health.rss",
        topics=["Health"],
    ),
    Outlet(
        id="variety",
        name="Variety",
        description="Entertainment industry news.",
        feed_url="https://variety.com/feed/",
        topics=["Entertainment"],
    ),
    Outlet(
        id="billboard",
        name="Billboard",
        description="Music and entertainment news.",
        feed_url="https://www.billboard.com/feed/",
        topics=["Entertainment"],
    ),
    Outlet(
        id="nasa",
        name="NASA",
        description="News and mission updates from NASA.",
        feed_url="https://www.nasa.gov/feed/",
        topics=["Science"],
    ),
    Outlet(
        id="science-daily",
        name="ScienceDaily",
        description="Research news across all fields of science.",
        feed_url="https://www.sciencedaily.com/rss/all.xml",
        topics=["Science"],
    ),
    Outlet(
        id="eater",
        name="Eater",
        description="Food and dining news and culture.",
        feed_url="https://www.eater.com/rss/index.xml",
        topics=["Food"],
    ),
]


def all_outlets() -> list[Outlet]:
    """Every known outlet - every country's list plus the topic pool - for search."""
    combined: list[Outlet] = []
    for outlets in OUTLET_CATALOG.values():
        combined.extend(outlets)
    combined.extend(TOPIC_FEED_POOL)
    return combined


def find_outlet(outlet_id: str) -> Outlet | None:
    for outlet in all_outlets():
        if outlet.id == outlet_id:
            return outlet
    return None

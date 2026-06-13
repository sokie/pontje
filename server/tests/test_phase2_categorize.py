from app.services.categorize import categorize


def test_host_rules_first_match() -> None:
    assert categorize("youtube.com") == "video"
    assert categorize("www.youtube.com") == "video"  # suffix semantics
    assert categorize("github.com") == "tech"
    assert categorize("gist.github.com") == "tech"
    assert categorize("amazon.de") == "shopping"  # "amazon." matches any TLD
    assert categorize("www.amazon.co.uk") == "shopping"
    assert categorize("reddit.com") == "social"
    assert categorize("music.apple.com") == "music"
    assert categorize("docs.google.com") == "docs"


def test_host_rules_respect_label_boundaries() -> None:
    assert categorize("notyoutube.com") == "other"
    assert categorize("notamazon.com") == "other"


def test_og_type_fallback() -> None:
    assert categorize("blog.example.com", "article") == "article"
    assert categorize("example.com", "video.movie") == "video"
    assert categorize("example.com", "music.song") == "music"


def test_host_rule_wins_over_og_type() -> None:
    assert categorize("github.com", "article") == "tech"


def test_unknown_is_other() -> None:
    assert categorize("example.com") == "other"
    assert categorize("example.com", "website") == "other"
    assert categorize("example.com", None) == "other"

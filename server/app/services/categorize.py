"""Link auto-categorization (PLAN.md §12) + file-type taxonomy (PLAN.md §14.4).

Ordered host rules from categories.json (first match wins), then the og:type
fallback, else "other". The JSON file is editable without redeploying — it is
read once at import.
"""

import json
from pathlib import Path

_RULES: list[dict] = json.loads(Path(__file__).with_name("categories.json").read_text())


def _host_matches(hostname: str, pattern: str) -> bool:
    """Suffix/contains semantics on label boundaries.

    - "youtube.com" matches "youtube.com" and "www.youtube.com" (suffix),
      but not "notyoutube.com".
    - A trailing-dot pattern like "amazon." matches any TLD: "amazon.de",
      "www.amazon.co.uk", … but not "notamazon.com".
    """
    if pattern.endswith("."):
        return hostname.startswith(pattern) or f".{pattern}" in hostname
    return hostname == pattern or hostname.endswith(f".{pattern}")


def categorize(hostname: str, og_type: str | None = None) -> str:
    host = hostname.strip().strip(".").lower()
    for rule in _RULES:
        if any(_host_matches(host, p) for p in rule["hosts"]):
            return rule["cat"]
    if og_type:
        t = og_type.strip().lower()
        if t.startswith("video"):
            return "video"
        if t == "article":
            return "article"
        if t.startswith("music"):
            return "music"
    return "other"


# File-type taxonomy (PLAN.md §14.4): MIME first, extension fallback.

_DOC_MIMES = {"application/pdf", "application/epub+zip"}
_DOC_EXTS = {
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "odt", "ods", "odp", "txt", "md", "epub", "rtf", "csv",
}
_ARCHIVE_EXTS = {"zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg"}
_CODE_EXTS = {
    "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "kt", "c", "cc", "cpp", "h",
    "hpp", "cs", "rb", "php", "swift", "sh", "zsh", "bash", "json", "yaml", "yml",
    "toml", "html", "css", "scss", "sql", "vue", "svelte",
}


def categorize_file(mime: str | None, file_name: str) -> str:
    m = (mime or "").lower().split(";")[0].strip()
    if m.startswith("image/"):
        return "image"
    if m.startswith("video/"):
        return "video"
    if m.startswith("audio/"):
        return "audio"
    if m in _DOC_MIMES or m.startswith("text/"):
        # text/* leans document; code is caught by extension below first
        pass
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if ext in _CODE_EXTS:
        return "code"
    if ext in _ARCHIVE_EXTS:
        return "archive"
    if ext in _DOC_EXTS or m in _DOC_MIMES or m.startswith("text/"):
        return "document"
    return "other"

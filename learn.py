#!/usr/bin/env python3
"""
Console tutor for German irregular verbs and nouns based on CSV sources.

The program builds a SQLite database on first run, imports the vocabulary,
tracks user performance, and adapts the questioning strategy over time.
"""
from __future__ import annotations

import csv
import json
import os
import random
import sqlite3
import sys
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "learning.db"

ADAPTIVE_AFTER_CYCLES = 5
MIN_ATTEMPTS_FOR_ADAPTIVE = 25
HIGH_ACCURACY_THRESHOLD = 0.88
EASY_REVIEW_FRACTION = 0.25  # share of "easy" cards kept in adaptive cycles
NUMBER_CYCLE_SIZE = 20
NUMBER_MAX_LIMIT = 1_000_000
NUMBER_DEFAULT_MAX = 1_000
FAMILY_CYCLE_SIZE = 20

FAMILY_LEVELS = ("A1", "A2")
FAMILY_CASES = ("nominative", "accusative", "dative")
FAMILY_MODES = ("noun", "phrase")
FAMILY_PRONOUNS = (
    "my",
    "your",
    "his",
    "her",
    "our",
    "your_pl",
    "their",
    "your_formal",
)

QUIT_COMMANDS = {"q", "quit", "exit"}
SHOW_COMMANDS = {"?", "help", "pomoc", "answer", "odgovor"}
SKIP_COMMANDS = {"skip", "naprej", "s"}
NOUN_LABELS = ["člen + samostalnik"]
VERB_LABELS = ["infinitiv", "3. oseba ednine", "preterit", "perfekt"]
NUMBER_LABELS = ["Zapis po nemško"]
FAMILY_LABELS_NOUN = ["člen + samostalnik", "plural (z die)"]
FAMILY_LABELS_NOUN_SINGULAR = ["člen + samostalnik"]
FAMILY_LABELS_NOUN_PLURAL = ["plural (z die)"]
FAMILY_LABELS_PHRASE = ["Zapis po nemško"]

USE_COLORS = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
COLOR_RESET = "\033[0m"
COLOR_NOUN = "\033[95m"  # magenta
COLOR_VERB = "\033[96m"  # cyan
COLOR_TITLE = "\033[93m"  # yellow


def color_text(content: str, color_code: str) -> str:
    if not USE_COLORS:
        return content
    return f"{color_code}{content}{COLOR_RESET}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_anonymous_user(user_id: Optional[int]) -> bool:
    return user_id is None or user_id <= 0


def normalize_text(
    value: str,
    allow_umlaut_fallback: bool = False,
    collapse_spaces: bool = True,
) -> str:
    cleaned = value.strip().lower().replace("ß", "ss")
    if collapse_spaces:
        cleaned = " ".join(cleaned.split())
    if allow_umlaut_fallback:
        cleaned = (
            cleaned.replace("ä", "ae")
            .replace("ö", "oe")
            .replace("ü", "ue")
        )
    return cleaned


NUMBER_BASIC = {
    0: "null",
    1: "eins",
    2: "zwei",
    3: "drei",
    4: "vier",
    5: "fünf",
    6: "sechs",
    7: "sieben",
    8: "acht",
    9: "neun",
    10: "zehn",
    11: "elf",
    12: "zwölf",
    13: "dreizehn",
    14: "vierzehn",
    15: "fünfzehn",
    16: "sechzehn",
    17: "siebzehn",
    18: "achtzehn",
    19: "neunzehn",
}

NUMBER_TENS = {
    20: "zwanzig",
    30: "dreißig",
    40: "vierzig",
    50: "fünfzig",
    60: "sechzig",
    70: "siebzig",
    80: "achtzig",
    90: "neunzig",
}

NUMBER_COMPONENT_KEYS = (
    "basic",
    "teens",
    "tens",
    "composite_tens",
    "hundreds",
    "composite_hundreds",
    "thousands",
    "composite_thousands",
)

FAMILY_CASE_LABELS = {
    "nominative": "Nominativ",
    "accusative": "Akuzativ",
    "dative": "Dativ",
}

FAMILY_GERMAN_ARTICLES = {
    "m": "der",
    "f": "die",
    "n": "das",
    "pl": "die",
}

FAMILY_SLO_PRONOUNS = {
    "my": {"m": "moj", "f": "moja", "n": "moje", "pl": "moji"},
    "your": {"m": "tvoj", "f": "tvoja", "n": "tvoje", "pl": "tvoji"},
    "his": {"m": "njegov", "f": "njegova", "n": "njegovo", "pl": "njegovi"},
    "her": {"m": "njen", "f": "njena", "n": "njeno", "pl": "njeni"},
    "our": {"m": "naš", "f": "naša", "n": "naše", "pl": "naši"},
    "your_pl": {"m": "vaš", "f": "vaša", "n": "vaše", "pl": "vaši"},
    "their": {"m": "njihov", "f": "njihova", "n": "njihovo", "pl": "njihovi"},
    "your_formal": {"m": "Vaš", "f": "Vaša", "n": "Vaše", "pl": "Vaši"},
}

FAMILY_GERMAN_PRONOUN_STEMS = {
    "my": "mein",
    "your": "dein",
    "his": "sein",
    "her": "ihr",
    "our": "unser",
    "your_pl": "euer",
    "their": "ihr",
    "your_formal": "Ihr",
}

FAMILY_GERMAN_ENDINGS = {
    "nominative": {"m": "", "f": "e", "n": "", "pl": "e"},
    "accusative": {"m": "en", "f": "e", "n": "", "pl": "e"},
    "dative": {"m": "em", "f": "er", "n": "em", "pl": "en"},
}


def number_to_german(value: int) -> str:
    if value < 0:
        raise ValueError("Število mora biti nenegativno.")
    if value > NUMBER_MAX_LIMIT:
        raise ValueError("Število je preveliko.")
    if value in NUMBER_BASIC:
        return NUMBER_BASIC[value]
    if value < 100:
        tens = (value // 10) * 10
        ones = value % 10
        tens_word = NUMBER_TENS[tens]
        if ones == 0:
            return tens_word
        ones_word = "ein" if ones == 1 else NUMBER_BASIC[ones]
        return f"{ones_word}und{tens_word}"
    if value < 1000:
        hundreds = value // 100
        remainder = value % 100
        prefix = "ein" if hundreds == 1 else NUMBER_BASIC[hundreds]
        base = f"{prefix}hundert"
        return base if remainder == 0 else base + number_to_german(remainder)
    if value < 1_000_000:
        thousands = value // 1000
        remainder = value % 1000
        prefix = "ein" if thousands == 1 else number_to_german(thousands)
        base = f"{prefix}tausend"
        return base if remainder == 0 else base + number_to_german(remainder)
    if value == 1_000_000:
        return "eine Million"
    raise ValueError("Število je preveliko.")


def number_component(value: int) -> str:
    if value <= 12:
        return "basic"
    if value <= 19:
        return "teens"
    if value < 100:
        return "tens" if value % 10 == 0 else "composite_tens"
    if value < 1000:
        return "hundreds" if value % 100 == 0 else "composite_hundreds"
    return "thousands" if value % 1000 == 0 else "composite_thousands"


def german_dative_plural(plural: str) -> str:
    if plural.endswith("n") or plural.endswith("s"):
        return plural
    return f"{plural}n"


def german_possessive(pronoun_key: str, case_name: str, gender: str) -> str:
    stem = FAMILY_GERMAN_PRONOUN_STEMS[pronoun_key]
    ending = FAMILY_GERMAN_ENDINGS[case_name][gender]
    if stem == "euer" and ending.startswith("e"):
        return f"eur{ending}"
    return f"{stem}{ending}"


def slovenian_possessive(pronoun_key: str, gender: str) -> str:
    forms = FAMILY_SLO_PRONOUNS.get(pronoun_key, {})
    return forms.get(gender, forms.get("m", ""))


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK(type IN ('noun', 'verb')),
            keyword TEXT NOT NULL,
            translation TEXT NOT NULL,
            solution_json TEXT NOT NULL,
            metadata_json TEXT,
            UNIQUE(type, keyword)
        );

        CREATE TABLE IF NOT EXISTS item_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposer_user_id INTEGER NOT NULL,
            item_id INTEGER,
            proposal_type TEXT NOT NULL CHECK(proposal_type IN ('create', 'update', 'delete')),
            status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
            word_type TEXT NOT NULL CHECK(word_type IN ('noun', 'verb')),
            keyword TEXT NOT NULL,
            translation TEXT NOT NULL,
            solution_json TEXT NOT NULL,
            metadata_json TEXT,
            proposed_at TEXT NOT NULL,
            reviewed_at TEXT,
            reviewer_user_id INTEGER,
            review_notes TEXT,
            FOREIGN KEY (proposer_user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_stats (
            user_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            wrong INTEGER NOT NULL DEFAULT 0,
            reveals INTEGER NOT NULL DEFAULT 0,
            correct_streak INTEGER NOT NULL DEFAULT 0,
            last_result TEXT,
            last_seen TEXT,
            PRIMARY KEY (user_id, entry_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL,
            asked_at TEXT NOT NULL,
            was_correct INTEGER NOT NULL,
            was_revealed INTEGER NOT NULL,
            answers_json TEXT NOT NULL,
            cycle_number INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_cycles (
            user_id INTEGER NOT NULL,
            word_type TEXT NOT NULL,
            cycles INTEGER NOT NULL DEFAULT 0,
            last_cycle_at TEXT,
            PRIMARY KEY (user_id, word_type),
            CHECK(word_type IN ('noun', 'verb')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS number_stats (
            user_id INTEGER NOT NULL,
            number INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            wrong INTEGER NOT NULL DEFAULT 0,
            reveals INTEGER NOT NULL DEFAULT 0,
            correct_streak INTEGER NOT NULL DEFAULT 0,
            last_result TEXT,
            last_seen TEXT,
            PRIMARY KEY (user_id, number),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS number_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            number INTEGER NOT NULL,
            asked_at TEXT NOT NULL,
            was_correct INTEGER NOT NULL,
            was_revealed INTEGER NOT NULL,
            answers_json TEXT NOT NULL,
            cycle_number INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS number_cycles (
            user_id INTEGER NOT NULL,
            cycles INTEGER NOT NULL DEFAULT 0,
            last_cycle_at TEXT,
            PRIMARY KEY (user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS family_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lemma TEXT NOT NULL,
            gender TEXT NOT NULL CHECK(gender IN ('m', 'f', 'n', 'pl')),
            plural TEXT NOT NULL,
            sl_singular TEXT NOT NULL,
            sl_plural TEXT NOT NULL,
            level TEXT NOT NULL CHECK(level IN ('A1', 'A2')),
            UNIQUE(lemma, gender)
        );

        CREATE TABLE IF NOT EXISTS family_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            mode TEXT NOT NULL CHECK(mode IN ('noun', 'phrase')),
            case_name TEXT,
            pronoun TEXT,
            number_form TEXT NOT NULL CHECK(number_form IN ('singular', 'plural', 'pair')),
            UNIQUE(item_id, mode, case_name, pronoun, number_form),
            FOREIGN KEY (item_id) REFERENCES family_items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS family_stats (
            user_id INTEGER NOT NULL,
            card_id INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            wrong INTEGER NOT NULL DEFAULT 0,
            reveals INTEGER NOT NULL DEFAULT 0,
            correct_streak INTEGER NOT NULL DEFAULT 0,
            last_result TEXT,
            last_seen TEXT,
            PRIMARY KEY (user_id, card_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (card_id) REFERENCES family_cards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS family_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            card_id INTEGER NOT NULL,
            asked_at TEXT NOT NULL,
            was_correct INTEGER NOT NULL,
            was_revealed INTEGER NOT NULL,
            answers_json TEXT NOT NULL,
            cycle_number INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (card_id) REFERENCES family_cards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS family_cycles (
            user_id INTEGER NOT NULL,
            cycles INTEGER NOT NULL DEFAULT 0,
            last_cycle_at TEXT,
            PRIMARY KEY (user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collection_id INTEGER NOT NULL,
            version_number INTEGER NOT NULL,
            title TEXT,
            description TEXT NOT NULL DEFAULT '',
            config_json TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK(visibility IN ('draft', 'unlisted', 'public')),
            access_code TEXT UNIQUE,
            created_at TEXT NOT NULL,
            published_at TEXT,
            FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
            UNIQUE(collection_id, version_number)
        );

        CREATE TABLE IF NOT EXISTS collection_version_items (
            collection_version_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            PRIMARY KEY (collection_version_id, item_id),
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE,
            FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_user_stats (
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            wrong INTEGER NOT NULL DEFAULT 0,
            reveals INTEGER NOT NULL DEFAULT 0,
            correct_streak INTEGER NOT NULL DEFAULT 0,
            last_result TEXT,
            last_seen TEXT,
            PRIMARY KEY (user_id, collection_version_id, entry_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL,
            asked_at TEXT NOT NULL,
            was_correct INTEGER NOT NULL,
            was_revealed INTEGER NOT NULL,
            answers_json TEXT NOT NULL,
            cycle_number INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_id) REFERENCES items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_cycles (
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            word_type TEXT NOT NULL CHECK(word_type IN ('noun', 'verb')),
            cycles INTEGER NOT NULL DEFAULT 0,
            last_cycle_at TEXT,
            PRIMARY KEY (user_id, collection_version_id, word_type),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_number_stats (
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            number INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            wrong INTEGER NOT NULL DEFAULT 0,
            reveals INTEGER NOT NULL DEFAULT 0,
            correct_streak INTEGER NOT NULL DEFAULT 0,
            last_result TEXT,
            last_seen TEXT,
            PRIMARY KEY (user_id, collection_version_id, number),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_number_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            number INTEGER NOT NULL,
            asked_at TEXT NOT NULL,
            was_correct INTEGER NOT NULL,
            was_revealed INTEGER NOT NULL,
            answers_json TEXT NOT NULL,
            cycle_number INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_number_cycles (
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            cycles INTEGER NOT NULL DEFAULT 0,
            last_cycle_at TEXT,
            PRIMARY KEY (user_id, collection_version_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_family_stats (
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            card_id INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            wrong INTEGER NOT NULL DEFAULT 0,
            reveals INTEGER NOT NULL DEFAULT 0,
            correct_streak INTEGER NOT NULL DEFAULT 0,
            last_result TEXT,
            last_seen TEXT,
            PRIMARY KEY (user_id, collection_version_id, card_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE,
            FOREIGN KEY (card_id) REFERENCES family_cards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_family_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            card_id INTEGER NOT NULL,
            asked_at TEXT NOT NULL,
            was_correct INTEGER NOT NULL,
            was_revealed INTEGER NOT NULL,
            answers_json TEXT NOT NULL,
            cycle_number INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE,
            FOREIGN KEY (card_id) REFERENCES family_cards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collection_family_cycles (
            user_id INTEGER NOT NULL,
            collection_version_id INTEGER NOT NULL,
            cycles INTEGER NOT NULL DEFAULT 0,
            last_cycle_at TEXT,
            PRIMARY KEY (user_id, collection_version_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (collection_version_id) REFERENCES collection_versions(id) ON DELETE CASCADE
        );
        """
    )
    columns = [row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "level" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 0")
    ensure_admin_user(conn)
    conn.commit()


def ensure_admin_user(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT id, level FROM users WHERE name = ?",
        ("admin",),
    ).fetchone()
    if row:
        current_level = row[1] if len(row) > 1 else 0
        if current_level < 3:
            conn.execute("UPDATE users SET level = 3 WHERE id = ?", (row[0],))
        return
    conn.execute(
        "INSERT INTO users (name, created_at, level) VALUES (?, ?, 3)",
        ("admin", now_iso()),
    )


def parse_csv_content(text: str) -> List[List[str]]:
    reader = csv.reader(StringIO(text))
    rows: List[List[str]] = []
    for row in reader:
        if not row or not any(cell.strip() for cell in row):
            continue
        rows.append([cell.strip() for cell in row])
    return rows


def build_noun_records(rows: List[List[str]]) -> Tuple[List[Tuple[str, str, str, str]], List[str]]:
    records: List[Tuple[str, str, str, str]] = []
    errors: List[str] = []
    for idx, row in enumerate(rows, start=1):
        if len(row) < 2:
            errors.append(f"Vrstica {idx}: pričakovana sta vsaj 2 stolpca.")
            continue
        term, translation = row[0], row[1]
        if not term or not translation:
            errors.append(f"Vrstica {idx}: prazna vrednost.")
            continue
        bits = term.split()
        article = bits[0] if bits else ""
        lemma = " ".join(bits[1:]) if len(bits) > 1 else ""
        metadata = {
            "article": article,
            "lemma": lemma,
            "labels": NOUN_LABELS,
        }
        records.append(
            (
                term.lower(),
                translation,
                json.dumps([term]),
                json.dumps(metadata),
            )
        )
    return records, errors


def build_verb_records(rows: List[List[str]]) -> Tuple[List[Tuple[str, str, str, str]], List[str]]:
    records: List[Tuple[str, str, str, str]] = []
    errors: List[str] = []
    for idx, row in enumerate(rows, start=1):
        if len(row) < 5:
            errors.append(f"Vrstica {idx}: pričakovanih je 5 stolpcev.")
            continue
        infinitive, third_person, preterite, perfect, translation = row[:5]
        if not infinitive or not translation:
            errors.append(f"Vrstica {idx}: manjkajoča oblika ali prevod.")
            continue
        metadata = {"labels": VERB_LABELS}
        records.append(
            (
                infinitive.lower(),
                translation,
                json.dumps([infinitive, third_person, preterite, perfect]),
                json.dumps(metadata),
            )
        )
    return records, errors


def import_records(conn: sqlite3.Connection, word_type: str, records: List[Tuple[str, str, str, str]]) -> Tuple[int, int]:
    added = 0
    skipped = 0
    for keyword, translation, solution_json, metadata_json in records:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO items (type, keyword, translation, solution_json, metadata_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (word_type, keyword, translation, solution_json, metadata_json),
        )
        if cur.rowcount:
            added += 1
        else:
            skipped += 1
    conn.commit()
    return added, skipped


def import_csv_text(conn: sqlite3.Connection, word_type: str, content: str) -> Dict[str, object]:
    rows = parse_csv_content(content)
    if word_type == "noun":
        records, errors = build_noun_records(rows)
    else:
        records, errors = build_verb_records(rows)
    added, skipped = import_records(conn, word_type, records)
    return {"added": added, "skipped": skipped, "errors": errors}


def load_family_csv_records() -> List[Dict[str, str]]:
    path = BASE_DIR / "druzina.csv"
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        records: List[Dict[str, str]] = []
        for row in reader:
            if not row:
                continue
            cleaned = {key: (value or "").strip() for key, value in row.items()}
            if not cleaned.get("lemma"):
                continue
            records.append(cleaned)
        return records


def seed_family_items(conn: sqlite3.Connection) -> int:
    records = load_family_csv_records()
    if not records:
        return 0
    added = 0
    for record in records:
        lemma = record.get("lemma", "")
        gender = record.get("gender", "")
        plural = record.get("plural", "")
        sl_singular = record.get("sl_singular", "")
        sl_plural = record.get("sl_plural", "")
        level = record.get("level", "")
        if (
            not lemma
            or gender not in {"m", "f", "n", "pl"}
            or not plural
            or not sl_singular
            or not sl_plural
            or level not in FAMILY_LEVELS
        ):
            continue
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO family_items (lemma, gender, plural, sl_singular, sl_plural, level)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (lemma, gender, plural, sl_singular, sl_plural, level),
        )
        if cur.rowcount:
            added += 1
    conn.commit()
    return added


def seed_family_cards(conn: sqlite3.Connection) -> int:
    rows = conn.execute(
        "SELECT id, gender FROM family_items ORDER BY id"
    ).fetchall()
    if not rows:
        return 0
    added = 0
    for row in rows:
        item_id = row["id"]
        gender = row["gender"]
        if gender == "pl":
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO family_cards (item_id, mode, case_name, pronoun, number_form)
                VALUES (?, 'noun', NULL, NULL, 'plural')
                """,
                (item_id,),
            )
            if cur.rowcount:
                added += 1
        else:
            for number_form in ("pair", "singular"):
                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO family_cards (item_id, mode, case_name, pronoun, number_form)
                    VALUES (?, 'noun', NULL, NULL, ?)
                    """,
                    (item_id, number_form),
                )
                if cur.rowcount:
                    added += 1
        phrase_number = "plural" if gender == "pl" else "singular"
        for case_name in FAMILY_CASES:
            for pronoun in FAMILY_PRONOUNS:
                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO family_cards (item_id, mode, case_name, pronoun, number_form)
                    VALUES (?, 'phrase', ?, ?, ?)
                    """,
                    (item_id, case_name, pronoun, phrase_number),
                )
                if cur.rowcount:
                    added += 1
    conn.commit()
    return added


def ensure_family_seed(conn: sqlite3.Connection) -> None:
    seed_family_items(conn)
    seed_family_cards(conn)


def prompt_username() -> str:
    while True:
        name = input("Kako ti je ime? ").strip()
        if name:
            return name
        print("Vpiši vsaj eno črko.")


def get_or_create_user(conn: sqlite3.Connection, name: str) -> int:
    row = conn.execute("SELECT id FROM users WHERE name = ?", (name,)).fetchone()
    if row:
        return int(row[0])
    cur = conn.execute(
        "INSERT INTO users (name, created_at, level) VALUES (?, ?, ?)",
        (name, now_iso(), 0),
    )
    conn.commit()
    return int(cur.lastrowid)


def fetch_items_with_stats(
    conn: sqlite3.Connection,
    user_id: int,
    word_type: str,
    collection_version_id: Optional[int] = None,
    restrict_to_collection_items: bool = False,
) -> List[Dict]:
    stats_table = "collection_user_stats" if collection_version_id else "user_stats"
    rows = conn.execute(
        f"""
        SELECT
            i.id,
            i.translation,
            i.solution_json,
            i.metadata_json,
            COALESCE(s.attempts, 0) AS attempts,
            COALESCE(s.correct, 0) AS correct,
            COALESCE(s.wrong, 0) AS wrong,
            COALESCE(s.reveals, 0) AS reveals,
            COALESCE(s.correct_streak, 0) AS streak,
            s.last_seen AS last_seen
        FROM items i
        LEFT JOIN {stats_table} s
            ON s.entry_id = i.id AND s.user_id = ?
            {"" if collection_version_id is None else "AND s.collection_version_id = ?"}
        {"" if not (restrict_to_collection_items and collection_version_id) else "JOIN collection_version_items cvi ON cvi.item_id = i.id AND cvi.collection_version_id = ?"}
        WHERE i.type = ?
        """,
        tuple(
            [user_id]
            + ([] if collection_version_id is None else [collection_version_id])
            + (
                []
                if not (restrict_to_collection_items and collection_version_id)
                else [collection_version_id]
            )
            + [word_type]
        ),
    ).fetchall()

    items = []
    for row in rows:
        metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
        solutions = json.loads(row["solution_json"])
        attempts = row["attempts"]
        wrong = row["wrong"]
        accuracy = 0.0
        if attempts:
            accuracy = (attempts - wrong) / attempts
        item = {
            "id": row["id"],
            "translation": row["translation"],
            "metadata": metadata,
            "solutions": solutions,
            "attempts": attempts,
            "correct": row["correct"],
            "wrong": wrong,
            "reveals": row["reveals"],
            "streak": row["streak"],
            "last_seen": row["last_seen"],
            "accuracy": accuracy,
        }
        item["difficulty"] = compute_difficulty(item)
        items.append(item)
    return items


def compute_difficulty(item: Dict) -> float:
    attempts = item["attempts"]
    wrong = item["wrong"]
    streak = item["streak"]
    reveals = item["reveals"]
    last_seen = item["last_seen"]

    if attempts == 0:
        return 5.0

    accuracy = (attempts - wrong) / attempts if attempts else 0.0
    diff = 1.0 + (1.0 - accuracy) * 4.0
    diff -= min(streak, 6) * 0.25
    diff += min(reveals, 5) * 0.15
    if last_seen:
        try:
            seen = datetime.fromisoformat(last_seen)
            delta_days = (datetime.now(timezone.utc) - seen).total_seconds() / 86400.0
            diff += min(max(delta_days / 4.0, 0.0), 1.0)
        except ValueError:
            diff += 0.2
    return max(diff, 0.1)


def fetch_cycle_count(
    conn: sqlite3.Connection,
    user_id: int,
    word_type: str,
    collection_version_id: Optional[int] = None,
) -> int:
    if is_anonymous_user(user_id):
        return 0
    if collection_version_id is None:
        row = conn.execute(
            "SELECT cycles FROM user_cycles WHERE user_id = ? AND word_type = ?",
            (user_id, word_type),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT cycles
            FROM collection_cycles
            WHERE user_id = ? AND collection_version_id = ? AND word_type = ?
            """,
            (user_id, collection_version_id, word_type),
        ).fetchone()
    return int(row["cycles"]) if row else 0


def increment_cycle(
    conn: sqlite3.Connection,
    user_id: int,
    word_type: str,
    collection_version_id: Optional[int] = None,
) -> None:
    if is_anonymous_user(user_id):
        return
    current = fetch_cycle_count(conn, user_id, word_type, collection_version_id=collection_version_id)
    if collection_version_id is None:
        if current == 0:
            conn.execute(
                """
                INSERT INTO user_cycles (user_id, word_type, cycles, last_cycle_at)
                VALUES (?, ?, 1, ?)
                """,
                (user_id, word_type, now_iso()),
            )
        else:
            conn.execute(
                """
                UPDATE user_cycles
                SET cycles = ?, last_cycle_at = ?
                WHERE user_id = ? AND word_type = ?
                """,
                (current + 1, now_iso(), user_id, word_type),
            )
    else:
        if current == 0:
            conn.execute(
                """
                INSERT INTO collection_cycles (user_id, collection_version_id, word_type, cycles, last_cycle_at)
                VALUES (?, ?, ?, 1, ?)
                """,
                (user_id, collection_version_id, word_type, now_iso()),
            )
        else:
            conn.execute(
                """
                UPDATE collection_cycles
                SET cycles = ?, last_cycle_at = ?
                WHERE user_id = ? AND collection_version_id = ? AND word_type = ?
                """,
                (current + 1, now_iso(), user_id, collection_version_id, word_type),
            )
    conn.commit()


def global_accuracy(
    conn: sqlite3.Connection,
    user_id: int,
    word_type: str,
    collection_version_id: Optional[int] = None,
    restrict_to_collection_items: bool = False,
) -> Tuple[int, float]:
    if collection_version_id is None:
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(s.attempts), 0) AS att,
                COALESCE(SUM(s.correct), 0) AS corr
            FROM user_stats s
            JOIN items i ON i.id = s.entry_id
            WHERE s.user_id = ? AND i.type = ?
            """,
            (user_id, word_type),
        ).fetchone()
    else:
        join_clause = ""
        params: List[object] = []
        if restrict_to_collection_items:
            join_clause = "JOIN collection_version_items cvi ON cvi.item_id = i.id AND cvi.collection_version_id = ?"
            params.append(collection_version_id)
        params.extend([user_id, collection_version_id, word_type])
        row = conn.execute(
            f"""
            SELECT
                COALESCE(SUM(s.attempts), 0) AS att,
                COALESCE(SUM(s.correct), 0) AS corr
            FROM collection_user_stats s
            JOIN items i ON i.id = s.entry_id
            {join_clause}
            WHERE s.user_id = ? AND s.collection_version_id = ? AND i.type = ?
            """,
            tuple(params),
        ).fetchone()
    attempts = int(row["att"])
    accuracy = (row["corr"] / attempts) if attempts else 0.0
    return attempts, accuracy


def fetch_number_cycle_count(
    conn: sqlite3.Connection, user_id: int, collection_version_id: Optional[int] = None
) -> int:
    if is_anonymous_user(user_id):
        return 0
    if collection_version_id is None:
        row = conn.execute(
            "SELECT cycles FROM number_cycles WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT cycles
            FROM collection_number_cycles
            WHERE user_id = ? AND collection_version_id = ?
            """,
            (user_id, collection_version_id),
        ).fetchone()
    return int(row["cycles"]) if row else 0


def increment_number_cycle(
    conn: sqlite3.Connection, user_id: int, collection_version_id: Optional[int] = None
) -> None:
    if is_anonymous_user(user_id):
        return
    current = fetch_number_cycle_count(conn, user_id, collection_version_id)
    if collection_version_id is None:
        if current == 0:
            conn.execute(
                """
                INSERT INTO number_cycles (user_id, cycles, last_cycle_at)
                VALUES (?, 1, ?)
                """,
                (user_id, now_iso()),
            )
        else:
            conn.execute(
                """
                UPDATE number_cycles
                SET cycles = ?, last_cycle_at = ?
                WHERE user_id = ?
                """,
                (current + 1, now_iso(), user_id),
            )
    else:
        if current == 0:
            conn.execute(
                """
                INSERT INTO collection_number_cycles (user_id, collection_version_id, cycles, last_cycle_at)
                VALUES (?, ?, 1, ?)
                """,
                (user_id, collection_version_id, now_iso()),
            )
        else:
            conn.execute(
                """
                UPDATE collection_number_cycles
                SET cycles = ?, last_cycle_at = ?
                WHERE user_id = ? AND collection_version_id = ?
                """,
                (current + 1, now_iso(), user_id, collection_version_id),
            )
    conn.commit()


def global_number_accuracy(
    conn: sqlite3.Connection, user_id: int, collection_version_id: Optional[int] = None
) -> Tuple[int, float]:
    if collection_version_id is None:
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(attempts), 0) AS att,
                COALESCE(SUM(correct), 0) AS corr
            FROM number_stats
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(attempts), 0) AS att,
                COALESCE(SUM(correct), 0) AS corr
            FROM collection_number_stats
            WHERE user_id = ? AND collection_version_id = ?
            """,
            (user_id, collection_version_id),
        ).fetchone()
    attempts = int(row["att"])
    accuracy = (row["corr"] / attempts) if attempts else 0.0
    return attempts, accuracy


def fetch_number_stats(
    conn: sqlite3.Connection,
    user_id: int,
    max_number: int,
    collection_version_id: Optional[int] = None,
) -> Dict[int, Dict]:
    if collection_version_id is None:
        rows = conn.execute(
            """
            SELECT
                number,
                attempts,
                correct,
                wrong,
                reveals,
                correct_streak,
                last_seen
            FROM number_stats
            WHERE user_id = ? AND number <= ?
            """,
            (user_id, max_number),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT
                number,
                attempts,
                correct,
                wrong,
                reveals,
                correct_streak,
                last_seen
            FROM collection_number_stats
            WHERE user_id = ? AND collection_version_id = ? AND number <= ?
            """,
            (user_id, collection_version_id, max_number),
        ).fetchall()
    stats_map: Dict[int, Dict] = {}
    for row in rows:
        stats_map[int(row["number"])] = {
            "attempts": row["attempts"],
            "correct": row["correct"],
            "wrong": row["wrong"],
            "reveals": row["reveals"],
            "streak": row["correct_streak"],
            "last_seen": row["last_seen"],
        }
    return stats_map


def default_number_stats() -> Dict[str, object]:
    return {
        "attempts": 0,
        "correct": 0,
        "wrong": 0,
        "reveals": 0,
        "streak": 0,
        "last_seen": None,
    }


def build_number_item(number: int, stats: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    payload = default_number_stats()
    if stats:
        payload.update(stats)
    attempts = int(payload["attempts"] or 0)
    wrong = int(payload["wrong"] or 0)
    accuracy = (attempts - wrong) / attempts if attempts else 0.0
    item = {
        "id": number,
        "translation": str(number),
        "attempts": attempts,
        "correct": int(payload["correct"] or 0),
        "wrong": wrong,
        "reveals": int(payload["reveals"] or 0),
        "streak": int(payload["streak"] or 0),
        "last_seen": payload["last_seen"],
        "accuracy": accuracy,
    }
    item["difficulty"] = compute_difficulty(item)
    return item


def choose_number_cycle_numbers(
    max_number: int,
    stats_map: Dict[int, Dict[str, object]],
    adaptive: bool,
    cycle_size: Optional[int] = None,
    components: Optional[Sequence[str]] = None,
) -> List[int]:
    if max_number < 0:
        return []
    numbers = list(range(0, max_number + 1))
    if components:
        component_set = set(components)
        numbers = [number for number in numbers if number_component(number) in component_set]
    total_count = len(numbers)
    if total_count == 0:
        return []
    if cycle_size is None or cycle_size <= 0:
        cycle_size = NUMBER_CYCLE_SIZE
    target_size = min(cycle_size, total_count)

    if not adaptive:
        if total_count <= target_size:
            random.shuffle(numbers)
            return numbers
        return random.sample(numbers, target_size)

    hard: List[int] = []
    easy: List[int] = []
    for number in numbers:
        stats = stats_map.get(number)
        attempts = int(stats["attempts"]) if stats else 0
        wrong = int(stats["wrong"]) if stats else 0
        streak = int(stats["streak"]) if stats else 0
        accuracy = (attempts - wrong) / attempts if attempts else 0.0
        if attempts == 0 or accuracy < HIGH_ACCURACY_THRESHOLD or streak < 3:
            hard.append(number)
        else:
            easy.append(number)

    random.shuffle(hard)
    random.shuffle(easy)

    easy_count = max(1, int(target_size * EASY_REVIEW_FRACTION))
    hard_count = max(0, target_size - easy_count)
    selected = hard[:hard_count] + easy[:easy_count]

    if len(selected) < target_size:
        remaining_pool = hard[hard_count:] + easy[easy_count:]
        selected += remaining_pool[: target_size - len(selected)]

    random.shuffle(selected)
    return selected


def fetch_family_cycle_count(
    conn: sqlite3.Connection, user_id: int, collection_version_id: Optional[int] = None
) -> int:
    if is_anonymous_user(user_id):
        return 0
    if collection_version_id is None:
        row = conn.execute(
            "SELECT cycles FROM family_cycles WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT cycles
            FROM collection_family_cycles
            WHERE user_id = ? AND collection_version_id = ?
            """,
            (user_id, collection_version_id),
        ).fetchone()
    return int(row["cycles"]) if row else 0


def increment_family_cycle(
    conn: sqlite3.Connection, user_id: int, collection_version_id: Optional[int] = None
) -> None:
    if is_anonymous_user(user_id):
        return
    current = fetch_family_cycle_count(conn, user_id, collection_version_id)
    if collection_version_id is None:
        if current == 0:
            conn.execute(
                """
                INSERT INTO family_cycles (user_id, cycles, last_cycle_at)
                VALUES (?, 1, ?)
                """,
                (user_id, now_iso()),
            )
        else:
            conn.execute(
                """
                UPDATE family_cycles
                SET cycles = ?, last_cycle_at = ?
                WHERE user_id = ?
                """,
                (current + 1, now_iso(), user_id),
            )
    else:
        if current == 0:
            conn.execute(
                """
                INSERT INTO collection_family_cycles (user_id, collection_version_id, cycles, last_cycle_at)
                VALUES (?, ?, 1, ?)
                """,
                (user_id, collection_version_id, now_iso()),
            )
        else:
            conn.execute(
                """
                UPDATE collection_family_cycles
                SET cycles = ?, last_cycle_at = ?
                WHERE user_id = ? AND collection_version_id = ?
                """,
                (current + 1, now_iso(), user_id, collection_version_id),
            )
    conn.commit()


def global_family_accuracy(
    conn: sqlite3.Connection, user_id: int, collection_version_id: Optional[int] = None
) -> Tuple[int, float]:
    if collection_version_id is None:
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(attempts), 0) AS att,
                COALESCE(SUM(correct), 0) AS corr
            FROM family_stats
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(attempts), 0) AS att,
                COALESCE(SUM(correct), 0) AS corr
            FROM collection_family_stats
            WHERE user_id = ? AND collection_version_id = ?
            """,
            (user_id, collection_version_id),
        ).fetchone()
    attempts = int(row["att"])
    accuracy = (row["corr"] / attempts) if attempts else 0.0
    return attempts, accuracy


def build_family_card_payload(row: sqlite3.Row) -> Tuple[str, List[str], List[str]]:
    gender = row["gender"]
    mode = row["mode"]
    if mode == "noun":
        if row["number_form"] == "plural":
            translation = row["sl_plural"]
            labels = FAMILY_LABELS_NOUN_PLURAL
            solutions = [f"die {row['plural']}"]
            return translation, labels, solutions
        article = FAMILY_GERMAN_ARTICLES[gender]
        if row["number_form"] == "singular":
            translation = row["sl_singular"]
            labels = FAMILY_LABELS_NOUN_SINGULAR
            solutions = [f"{article} {row['lemma']}"]
            return translation, labels, solutions
        translation = f"{row['sl_singular']} / {row['sl_plural']}"
        labels = FAMILY_LABELS_NOUN
        solutions = [f"{article} {row['lemma']}", f"die {row['plural']}"]
        return translation, labels, solutions

    case_name = row["case_name"]
    pronoun = row["pronoun"]
    case_label = FAMILY_CASE_LABELS[case_name]
    effective_gender = "pl" if gender == "pl" else gender
    sl_pronoun = slovenian_possessive(pronoun, effective_gender)
    sl_noun = row["sl_plural"] if gender == "pl" else row["sl_singular"]
    translation = f"{case_label}: {sl_pronoun} {sl_noun}"
    labels = FAMILY_LABELS_PHRASE
    noun_form = row["plural"] if gender == "pl" else row["lemma"]
    if case_name == "dative" and gender == "pl":
        noun_form = german_dative_plural(noun_form)
    determiner = german_possessive(pronoun, case_name, effective_gender)
    solutions = [f"{determiner} {noun_form}"]
    return translation, labels, solutions


def fetch_family_cards_with_stats(
    conn: sqlite3.Connection,
    user_id: int,
    levels: Sequence[str],
    modes: Sequence[str],
    cases: Optional[Sequence[str]] = None,
    include_plural: bool = True,
    collection_version_id: Optional[int] = None,
) -> List[Dict]:
    if not levels or not modes:
        return []
    stats_table = "collection_family_stats" if collection_version_id else "family_stats"
    params: List[object] = [user_id]
    if collection_version_id is not None:
        params.append(collection_version_id)
    level_placeholders = ", ".join("?" * len(levels))
    mode_placeholders = ", ".join("?" * len(modes))
    params.extend(levels)
    params.extend(modes)
    query = f"""
    SELECT
        c.id AS card_id,
        c.mode,
        c.case_name,
        c.pronoun,
        c.number_form,
        i.lemma,
        i.gender,
        i.plural,
        i.sl_singular,
        i.sl_plural,
        i.level,
        COALESCE(s.attempts, 0) AS attempts,
        COALESCE(s.correct, 0) AS correct,
        COALESCE(s.wrong, 0) AS wrong,
        COALESCE(s.reveals, 0) AS reveals,
        COALESCE(s.correct_streak, 0) AS streak,
        s.last_seen AS last_seen
    FROM family_cards c
    JOIN family_items i ON i.id = c.item_id
    LEFT JOIN {stats_table} s
      ON s.card_id = c.id AND s.user_id = ?
      {"" if collection_version_id is None else "AND s.collection_version_id = ?"}
    WHERE i.level IN ({level_placeholders})
      AND c.mode IN ({mode_placeholders})
    """
    if cases and "phrase" in modes:
        case_placeholders = ", ".join("?" * len(cases))
        query += f" AND (c.mode != 'phrase' OR c.case_name IN ({case_placeholders}))"
        params.extend(cases)
    noun_forms = ("pair", "plural") if include_plural else ("singular", "plural")
    noun_placeholders = ", ".join("?" * len(noun_forms))
    query += f" AND (c.mode != 'noun' OR c.number_form IN ({noun_placeholders}))"
    params.extend(noun_forms)
    rows = conn.execute(query, tuple(params)).fetchall()
    items: List[Dict] = []
    for row in rows:
        translation, labels, solutions = build_family_card_payload(row)
        attempts = row["attempts"]
        wrong = row["wrong"]
        accuracy = (attempts - wrong) / attempts if attempts else 0.0
        item = {
            "id": row["card_id"],
            "translation": translation,
            "labels": labels,
            "solutions": solutions,
            "attempts": attempts,
            "correct": row["correct"],
            "wrong": wrong,
            "reveals": row["reveals"],
            "streak": row["streak"],
            "last_seen": row["last_seen"],
            "accuracy": accuracy,
        }
        item["difficulty"] = compute_difficulty(item)
        items.append(item)
    return items


def fetch_family_results(
    conn: sqlite3.Connection,
    user_id: int,
    levels: Sequence[str],
    modes: Sequence[str],
    cases: Optional[Sequence[str]] = None,
    include_plural: bool = True,
    collection_version_id: Optional[int] = None,
) -> List[Dict]:
    if not levels or not modes:
        return []
    stats_table = "collection_family_stats" if collection_version_id else "family_stats"
    params: List[object] = [user_id]
    if collection_version_id is not None:
        params.append(collection_version_id)
    level_placeholders = ", ".join("?" * len(levels))
    mode_placeholders = ", ".join("?" * len(modes))
    params.extend(levels)
    params.extend(modes)
    query = f"""
    SELECT
        c.id AS card_id,
        c.mode,
        c.case_name,
        c.pronoun,
        c.number_form,
        i.lemma,
        i.gender,
        i.plural,
        i.sl_singular,
        i.sl_plural,
        i.level,
        s.attempts,
        s.correct,
        s.wrong,
        s.reveals,
        s.correct_streak,
        s.last_seen
    FROM {stats_table} s
    JOIN family_cards c ON c.id = s.card_id
    JOIN family_items i ON i.id = c.item_id
    WHERE s.user_id = ?
      {"" if collection_version_id is None else "AND s.collection_version_id = ?"}
      AND i.level IN ({level_placeholders})
      AND c.mode IN ({mode_placeholders})
    """
    if cases and "phrase" in modes:
        case_placeholders = ", ".join("?" * len(cases))
        query += f" AND (c.mode != 'phrase' OR c.case_name IN ({case_placeholders}))"
        params.extend(cases)
    noun_forms = ("pair", "plural") if include_plural else ("singular", "plural")
    noun_placeholders = ", ".join("?" * len(noun_forms))
    query += f" AND (c.mode != 'noun' OR c.number_form IN ({noun_placeholders}))"
    params.extend(noun_forms)
    rows = conn.execute(query, tuple(params)).fetchall()
    results: List[Dict] = []
    for row in rows:
        translation, labels, solutions = build_family_card_payload(row)
        results.append(
            {
                "id": row["card_id"],
                "translation": translation,
                "labels": labels,
                "solutions": solutions,
                "attempts": row["attempts"],
                "correct": row["correct"],
                "wrong": row["wrong"],
                "reveals": row["reveals"],
                "streak": row["correct_streak"],
            }
        )
    return results


def fetch_family_card(conn: sqlite3.Connection, card_id: int) -> Optional[sqlite3.Row]:
    row = conn.execute(
        """
        SELECT
            c.id AS card_id,
            c.mode,
            c.case_name,
            c.pronoun,
            c.number_form,
            i.lemma,
            i.gender,
            i.plural,
            i.sl_singular,
            i.sl_plural,
            i.level
        FROM family_cards c
        JOIN family_items i ON i.id = c.item_id
        WHERE c.id = ?
        """,
        (card_id,),
    ).fetchone()
    return row


def choose_family_cycle_items(items: List[Dict], adaptive: bool) -> List[Dict]:
    if not items:
        return []
    shuffled = items[:]
    random.shuffle(shuffled)
    target_size = min(FAMILY_CYCLE_SIZE, len(shuffled))

    if not adaptive:
        if len(shuffled) <= target_size:
            return shuffled
        return random.sample(shuffled, target_size)

    hard_items = [
        item
        for item in shuffled
        if item["attempts"] == 0
        or item["accuracy"] < HIGH_ACCURACY_THRESHOLD
        or item["streak"] < 3
    ]
    easy_items = [item for item in shuffled if item not in hard_items]

    easy_count = max(1, int(target_size * EASY_REVIEW_FRACTION))
    hard_count = max(0, target_size - easy_count)
    selected = hard_items[:hard_count]
    if easy_items:
        selected += random.sample(easy_items, min(len(easy_items), easy_count))

    if len(selected) < target_size:
        remaining_pool = hard_items[hard_count:] + [
            item for item in easy_items if item not in selected
        ]
        selected += remaining_pool[: target_size - len(selected)]

    selected.sort(key=lambda i: i["difficulty"], reverse=True)
    return selected


def choose_cycle_items(items: List[Dict], adaptive: bool) -> List[Dict]:
    if not items:
        return []

    shuffled = items[:]
    random.shuffle(shuffled)

    if not adaptive:
        return shuffled

    hard_items = [
        item
        for item in shuffled
        if item["attempts"] == 0
        or item["accuracy"] < HIGH_ACCURACY_THRESHOLD
        or item["streak"] < 3
    ]
    easy_items = [item for item in shuffled if item not in hard_items]

    keep_easy = max(1, int(len(items) * EASY_REVIEW_FRACTION))
    review_items = random.sample(easy_items, min(len(easy_items), keep_easy)) if easy_items else []

    selection = hard_items + review_items
    selection.sort(key=lambda i: i["difficulty"], reverse=True)
    return selection


def get_labels(word_type: str, metadata: Dict) -> List[str]:
    stored = metadata.get("labels")
    if stored:
        return stored
    if word_type == "number":
        return NUMBER_LABELS
    if word_type == "family":
        return FAMILY_LABELS_PHRASE
    if word_type == "verb":
        return VERB_LABELS
    return NOUN_LABELS


def ask_yes_no(prompt: str) -> bool:
    while True:
        answer = input(prompt).strip().lower()
        if answer in {"da", "d", "y", "yes"}:
            return True
        if answer in {"ne", "n", "no"}:
            return False
        print("Odgovori z da/ne.")


def show_solution(word_type: str, labels: Sequence[str], solutions: Sequence[str]) -> None:
    print("Pravilen odgovor:")
    for label, solution in zip(labels, solutions):
        print(f"  - {label}: {solution}")


def collect_answers(labels: Sequence[str]) -> Tuple[Optional[List[str]], bool, bool]:
    answers: List[str] = []
    revealed = False
    aborted = False

    for label in labels:
        raw = input(f"  {label}: ").strip()
        lowered = raw.lower()
        if lowered in QUIT_COMMANDS:
            aborted = True
            break
        if lowered in SHOW_COMMANDS:
            revealed = True
            break
        if lowered in SKIP_COMMANDS or raw == "":
            answers.append("")
        else:
            answers.append(raw)

    return (answers if not aborted else None), revealed, aborted


def check_answers(
    user_answers: Sequence[str],
    solutions: Sequence[str],
    allow_umlaut_fallback: bool = False,
    collapse_spaces: bool = True,
) -> bool:
    normalized_user = [
        normalize_text(
            value,
            allow_umlaut_fallback=allow_umlaut_fallback,
            collapse_spaces=collapse_spaces,
        )
        for value in user_answers
    ]
    normalized_sol = [
        normalize_text(
            value,
            allow_umlaut_fallback=allow_umlaut_fallback,
            collapse_spaces=collapse_spaces,
        )
        for value in solutions
    ]
    return normalized_user == normalized_sol


def ask_question(item: Dict, word_type: str) -> Dict:
    translation = item["translation"]
    metadata = item["metadata"]
    labels = get_labels(word_type, metadata)
    solutions = item["solutions"]

    print("\n----------------------------------------")
    type_label = "SAMOSTALNIK" if word_type == "noun" else "NEPRAVILNI GLAGOL"
    header_color = COLOR_NOUN if word_type == "noun" else COLOR_VERB
    print(color_text(type_label, header_color))
    meaning_line = f"Pomen v slovenščini: {translation}"
    print(color_text(meaning_line, COLOR_TITLE))
    print("Vpiši '?' če želiš takoj videti rešitev ali 'q' za izhod.")

    answers, revealed, aborted = collect_answers(labels)
    if aborted:
        return {"quit": True}

    if revealed or answers is None:
        show_solution(word_type, labels, solutions)
        return {"correct": False, "revealed": True, "answers": answers or []}

    if len(answers) < len(solutions):
        answers.extend([""] * (len(solutions) - len(answers)))

    correct = check_answers(answers, solutions)
    if correct:
        print("✅ Pravilno!")
        return {"correct": True, "revealed": False, "answers": answers}

    print("❌ Ni bilo pravilno.")
    if ask_yes_no("Želiš videti pravilen odgovor? (da/ne): "):
        show_solution(word_type, labels, solutions)
        return {"correct": False, "revealed": True, "answers": answers}

    print("Poskusi si zapomniti pravilno obliko za naslednjič.")
    return {"correct": False, "revealed": False, "answers": answers}


def update_progress(
    conn: sqlite3.Connection,
    user_id: int,
    item_id: int,
    correct: bool,
    revealed: bool,
    answers: Sequence[str],
    cycle_number: int,
    collection_version_id: Optional[int] = None,
) -> None:
    if is_anonymous_user(user_id):
        return
    now = now_iso()
    result_label = "correct" if correct else ("revealed" if revealed else "wrong")
    correct_value = 1 if correct else 0
    wrong_value = 0 if correct else 1
    reveal_value = 1 if revealed else 0
    if collection_version_id is None:
        conn.execute(
            """
            INSERT INTO user_stats (
                user_id, entry_id, attempts, correct, wrong, reveals, correct_streak, last_result, last_seen
            )
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, entry_id) DO UPDATE SET
                attempts = user_stats.attempts + 1,
                correct = user_stats.correct + excluded.correct,
                wrong = user_stats.wrong + excluded.wrong,
                reveals = user_stats.reveals + excluded.reveals,
                correct_streak = CASE
                    WHEN excluded.last_result = 'correct' THEN user_stats.correct_streak + 1
                    ELSE 0
                END,
                last_result = excluded.last_result,
                last_seen = excluded.last_seen
            """,
            (
                user_id,
                item_id,
                correct_value,
                wrong_value,
                reveal_value,
                1 if correct else 0,
                result_label,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO attempts (user_id, entry_id, asked_at, was_correct, was_revealed, answers_json, cycle_number)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                item_id,
                now,
                correct_value,
                reveal_value,
                json.dumps(list(answers)),
                cycle_number,
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO collection_user_stats (
                user_id,
                collection_version_id,
                entry_id,
                attempts,
                correct,
                wrong,
                reveals,
                correct_streak,
                last_result,
                last_seen
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, collection_version_id, entry_id) DO UPDATE SET
                attempts = collection_user_stats.attempts + 1,
                correct = collection_user_stats.correct + excluded.correct,
                wrong = collection_user_stats.wrong + excluded.wrong,
                reveals = collection_user_stats.reveals + excluded.reveals,
                correct_streak = CASE
                    WHEN excluded.last_result = 'correct' THEN collection_user_stats.correct_streak + 1
                    ELSE 0
                END,
                last_result = excluded.last_result,
                last_seen = excluded.last_seen
            """,
            (
                user_id,
                collection_version_id,
                item_id,
                correct_value,
                wrong_value,
                reveal_value,
                1 if correct else 0,
                result_label,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO collection_attempts (
                user_id,
                collection_version_id,
                entry_id,
                asked_at,
                was_correct,
                was_revealed,
                answers_json,
                cycle_number
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                collection_version_id,
                item_id,
                now,
                correct_value,
                reveal_value,
                json.dumps(list(answers)),
                cycle_number,
            ),
        )
    conn.commit()


def update_number_progress(
    conn: sqlite3.Connection,
    user_id: int,
    number: int,
    correct: bool,
    revealed: bool,
    answers: Sequence[str],
    cycle_number: int,
    collection_version_id: Optional[int] = None,
) -> None:
    if is_anonymous_user(user_id):
        return
    now = now_iso()
    result_label = "correct" if correct else ("revealed" if revealed else "wrong")
    correct_value = 1 if correct else 0
    wrong_value = 0 if correct else 1
    reveal_value = 1 if revealed else 0
    if collection_version_id is None:
        conn.execute(
            """
            INSERT INTO number_stats (
                user_id, number, attempts, correct, wrong, reveals, correct_streak, last_result, last_seen
            )
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, number) DO UPDATE SET
                attempts = number_stats.attempts + 1,
                correct = number_stats.correct + excluded.correct,
                wrong = number_stats.wrong + excluded.wrong,
                reveals = number_stats.reveals + excluded.reveals,
                correct_streak = CASE
                    WHEN excluded.last_result = 'correct' THEN number_stats.correct_streak + 1
                    ELSE 0
                END,
                last_result = excluded.last_result,
                last_seen = excluded.last_seen
            """,
            (
                user_id,
                number,
                correct_value,
                wrong_value,
                reveal_value,
                1 if correct else 0,
                result_label,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO number_attempts (user_id, number, asked_at, was_correct, was_revealed, answers_json, cycle_number)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                number,
                now,
                correct_value,
                reveal_value,
                json.dumps(list(answers)),
                cycle_number,
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO collection_number_stats (
                user_id,
                collection_version_id,
                number,
                attempts,
                correct,
                wrong,
                reveals,
                correct_streak,
                last_result,
                last_seen
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, collection_version_id, number) DO UPDATE SET
                attempts = collection_number_stats.attempts + 1,
                correct = collection_number_stats.correct + excluded.correct,
                wrong = collection_number_stats.wrong + excluded.wrong,
                reveals = collection_number_stats.reveals + excluded.reveals,
                correct_streak = CASE
                    WHEN excluded.last_result = 'correct' THEN collection_number_stats.correct_streak + 1
                    ELSE 0
                END,
                last_result = excluded.last_result,
                last_seen = excluded.last_seen
            """,
            (
                user_id,
                collection_version_id,
                number,
                correct_value,
                wrong_value,
                reveal_value,
                1 if correct else 0,
                result_label,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO collection_number_attempts (
                user_id,
                collection_version_id,
                number,
                asked_at,
                was_correct,
                was_revealed,
                answers_json,
                cycle_number
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                collection_version_id,
                number,
                now,
                correct_value,
                reveal_value,
                json.dumps(list(answers)),
                cycle_number,
            ),
        )
    conn.commit()


def update_family_progress(
    conn: sqlite3.Connection,
    user_id: int,
    card_id: int,
    correct: bool,
    revealed: bool,
    answers: Sequence[str],
    cycle_number: int,
    collection_version_id: Optional[int] = None,
) -> None:
    if is_anonymous_user(user_id):
        return
    now = now_iso()
    result_label = "correct" if correct else ("revealed" if revealed else "wrong")
    correct_value = 1 if correct else 0
    wrong_value = 0 if correct else 1
    reveal_value = 1 if revealed else 0
    if collection_version_id is None:
        conn.execute(
            """
            INSERT INTO family_stats (
                user_id, card_id, attempts, correct, wrong, reveals, correct_streak, last_result, last_seen
            )
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, card_id) DO UPDATE SET
                attempts = family_stats.attempts + 1,
                correct = family_stats.correct + excluded.correct,
                wrong = family_stats.wrong + excluded.wrong,
                reveals = family_stats.reveals + excluded.reveals,
                correct_streak = CASE
                    WHEN excluded.last_result = 'correct' THEN family_stats.correct_streak + 1
                    ELSE 0
                END,
                last_result = excluded.last_result,
                last_seen = excluded.last_seen
            """,
            (
                user_id,
                card_id,
                correct_value,
                wrong_value,
                reveal_value,
                1 if correct else 0,
                result_label,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO family_attempts (user_id, card_id, asked_at, was_correct, was_revealed, answers_json, cycle_number)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                card_id,
                now,
                correct_value,
                reveal_value,
                json.dumps(list(answers)),
                cycle_number,
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO collection_family_stats (
                user_id,
                collection_version_id,
                card_id,
                attempts,
                correct,
                wrong,
                reveals,
                correct_streak,
                last_result,
                last_seen
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, collection_version_id, card_id) DO UPDATE SET
                attempts = collection_family_stats.attempts + 1,
                correct = collection_family_stats.correct + excluded.correct,
                wrong = collection_family_stats.wrong + excluded.wrong,
                reveals = collection_family_stats.reveals + excluded.reveals,
                correct_streak = CASE
                    WHEN excluded.last_result = 'correct' THEN collection_family_stats.correct_streak + 1
                    ELSE 0
                END,
                last_result = excluded.last_result,
                last_seen = excluded.last_seen
            """,
            (
                user_id,
                collection_version_id,
                card_id,
                correct_value,
                wrong_value,
                reveal_value,
                1 if correct else 0,
                result_label,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO collection_family_attempts (
                user_id,
                collection_version_id,
                card_id,
                asked_at,
                was_correct,
                was_revealed,
                answers_json,
                cycle_number
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                collection_version_id,
                card_id,
                now,
                correct_value,
                reveal_value,
                json.dumps(list(answers)),
                cycle_number,
            ),
        )
    conn.commit()


def session_loop(conn: sqlite3.Connection, user_id: int, word_type: str) -> None:
    print_module_instructions(word_type)
    while True:
        cycle_index = fetch_cycle_count(conn, user_id, word_type) + 1
        total_attempts, accuracy = global_accuracy(conn, user_id, word_type)
        adaptive = (
            cycle_index > ADAPTIVE_AFTER_CYCLES
            or (total_attempts >= MIN_ATTEMPTS_FOR_ADAPTIVE and accuracy >= HIGH_ACCURACY_THRESHOLD)
        )

        items = fetch_items_with_stats(conn, user_id, word_type)
        if not items:
            print("Ni vnosov za ta sklop. Preveri CSV datoteke.")
            return

        cycle_items = choose_cycle_items(items, adaptive)
        if not cycle_items:
            print("Ni kartic, ki bi jih bilo treba vaditi. Vseeno preglejmo osnovni seznam.")
            cycle_items = items

        mode_note = "adaptivni natančni način" if adaptive else "naključni način"
        print(f"\nZačenjamo cikel #{cycle_index} ({mode_note}). Skupno vprašanj: {len(cycle_items)}")

        for idx, item in enumerate(cycle_items, start=1):
            print(f"\nVprašanje {idx}/{len(cycle_items)}")
            result = ask_question(item, word_type)
            if result.get("quit"):
                print("Prekinili smo sejo.")
                return
            update_progress(
                conn,
                user_id,
                item["id"],
                bool(result.get("correct")),
                bool(result.get("revealed")),
                result.get("answers") or [],
                cycle_index,
            )

        increment_cycle(conn, user_id, word_type)
        print("\nCikel zaključen! 🏁")
        stats_line(conn, user_id, word_type)

        if not ask_yes_no("Zaženemo še en cikel z istim sklopom? (da/ne): "):
            break


def stats_line(conn: sqlite3.Connection, user_id: int, word_type: str) -> None:
    row = conn.execute(
        """
        SELECT
            COALESCE(SUM(correct), 0) AS correct,
            COALESCE(SUM(wrong), 0) AS wrong,
            COALESCE(SUM(reveals), 0) AS reveals
        FROM user_stats
        JOIN items ON items.id = user_stats.entry_id
        WHERE user_id = ? AND items.type = ?
        """,
        (user_id, word_type),
    ).fetchone()
    correct = row["correct"]
    wrong = row["wrong"]
    reveals = row["reveals"]
    total = correct + wrong
    accuracy = (correct / total) * 100 if total else 0.0
    print(
        f"Dosedanje razmerje: {correct} pravilnih, {wrong} napačnih, {reveals} pogledov rešitev "
        f"({accuracy:.1f}% uspešnost)."
    )


def choose_module() -> Optional[str]:
    print("\nKaj želiš vaditi?")
    print("  1) Samostalniki")
    print("  2) Nepravilni glagoli")
    print("  q) Izhod")
    answer = input("Izbira: ").strip().lower()
    if answer == "1":
        return "noun"
    if answer == "2":
        return "verb"
    if answer in QUIT_COMMANDS:
        return None
    print("Neznana izbira, poskusi znova.")
    return choose_module()


def print_module_instructions(word_type: str) -> None:
    print("\nNavodila:")
    if word_type == "noun":
        print("  - Napiši člen in samostalnik v isti vrstici (npr. 'der Nachwuchs').")
    else:
        print("  - Vnesi oblike v zaporedju: infinitiv, 3. oseba ednine, preterit, perfekt.")
    print("  - Vnesi '?' če želiš takoj videti rešitev ali 'q' za izhod.")


def main() -> None:
    random.seed()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    ensure_schema(conn)

    print("Nemški trener (samostalniki + nepravilni glagoli)")
    username = prompt_username()
    user_id = get_or_create_user(conn, username)
    print(f"Pozdravljen, {username}! Izberi kaj želiš utrjevati.")

    try:
        while True:
            module = choose_module()
            if module is None:
                print("Nasvidenje!")
                break
            session_loop(conn, user_id, module)
    except KeyboardInterrupt:
        print("\nPrekinjeno. Nasvidenje!")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

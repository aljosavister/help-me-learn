#!/usr/bin/env python3
"""
FastAPI service for the German vocabulary trainer.

This API reuses the same SQLite database and learning logic as the CLI program
in learn.py. It lets clients create users, request adaptive practice cycles,
and submit answers so that statistics remain synchronized.
"""
from __future__ import annotations

import json
import random
import sqlite3
from typing import Dict, Generator, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Response, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import learn

WordType = Literal["noun", "verb", "number", "family"]
ProposalStatus = Literal["pending", "approved", "rejected"]
NumberComponent = Literal[
    "basic",
    "teens",
    "tens",
    "composite_tens",
    "hundreds",
    "composite_hundreds",
    "thousands",
    "composite_thousands",
]
FamilyMode = Literal["noun", "phrase"]
FamilyCase = Literal["nominative", "accusative", "dative"]
FamilyLevel = Literal["A1", "A2"]
CollectionVisibility = Literal["draft", "unlisted", "public"]

ALLOWED_MODULES = ("noun", "verb", "number", "family")
USER_LEVEL_ANONYMOUS = 0
USER_LEVEL_AUTHOR = 1
USER_LEVEL_EDITOR = 2
USER_LEVEL_ADMIN = 3

app = FastAPI(
    title="German Trainer API",
    description="API za učenje nemških samostalnikov in nepravilnih glagolov.",
    version="0.1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(learn.DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def serialize_item_row(row: sqlite3.Row, include_solution: bool = False) -> ItemOut:
    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
    labels = learn.get_labels(row["type"], metadata)
    solution = json.loads(row["solution_json"]) if include_solution and row["solution_json"] else None
    return ItemOut(
        id=row["id"],
        type=row["type"],
        translation=row["translation"],
        metadata=metadata,
        labels=labels,
        solution=solution,
        attempts=row["attempts"] if "attempts" in row.keys() else None,
        correct=row["correct"] if "correct" in row.keys() else None,
        wrong=row["wrong"] if "wrong" in row.keys() else None,
        reveals=row["reveals"] if "reveals" in row.keys() else None,
        streak=row["streak"] if "streak" in row.keys() else None,
    )


def serialize_proposal_row(row: sqlite3.Row) -> ItemProposalOut:
    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
    solution = json.loads(row["solution_json"]) if row["solution_json"] else []
    return ItemProposalOut(
        id=row["id"],
        proposal_type=row["proposal_type"],
        status=row["status"],
        word_type=row["word_type"],
        item_id=row["item_id"],
        keyword=row["keyword"],
        translation=row["translation"],
        solution=solution,
        metadata=metadata,
        proposer_user_id=row["proposer_user_id"],
        proposer_name=row["proposer_name"],
        proposed_at=row["proposed_at"],
        reviewer_user_id=row["reviewer_user_id"],
        reviewer_name=row["reviewer_name"],
        reviewed_at=row["reviewed_at"],
        review_notes=row["review_notes"],
    )


def _init_database() -> None:
    conn = _connect_db()
    conn.row_factory = sqlite3.Row
    learn.ensure_schema(conn)
    learn.ensure_family_seed(conn)
    conn.close()


_init_database()
random.seed()


def get_db() -> Generator[sqlite3.Connection, None, None]:
    conn = _connect_db()
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def ensure_user(conn: sqlite3.Connection, user_id: int) -> None:
    if user_id <= 0:
        return
    row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Uporabnik ne obstaja.")


def get_user_level(conn: sqlite3.Connection, user_id: int) -> int:
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="Uporabnik mora biti prijavljen.")
    row = conn.execute("SELECT level FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Uporabnik ne obstaja.")
    return int(row["level"] or 0)


def ensure_moderator(conn: sqlite3.Connection, user_id: int) -> None:
    level = get_user_level(conn, user_id)
    if level < USER_LEVEL_EDITOR:
        raise HTTPException(status_code=403, detail="Nimaš pravic za potrjevanje predlogov.")


def ensure_admin(conn: sqlite3.Connection, user_id: int) -> None:
    level = get_user_level(conn, user_id)
    if level < USER_LEVEL_ADMIN:
        raise HTTPException(status_code=403, detail="Nimaš pravic za urejanje nivojev.")


def ensure_author(conn: sqlite3.Connection, user_id: int) -> None:
    level = get_user_level(conn, user_id)
    if level < USER_LEVEL_AUTHOR:
        raise HTTPException(status_code=403, detail="Nimaš pravic za pošiljanje predlogov.")


def _normalize_collection_config(raw: Optional[Dict[str, object]]) -> Dict[str, object]:
    config = raw if isinstance(raw, dict) else {}
    modules_raw = config.get("modules")
    if isinstance(modules_raw, str):
        modules_raw = [modules_raw]
    if not isinstance(modules_raw, list):
        modules_raw = []
    modules = [mod for mod in modules_raw if mod in ALLOWED_MODULES]
    if not modules:
        modules = list(ALLOWED_MODULES)
    normalized: Dict[str, object] = {"modules": modules}

    if "noun" in modules:
        noun_cfg = config.get("noun") if isinstance(config.get("noun"), dict) else {}
        scope = noun_cfg.get("scope")
        normalized["noun"] = {"scope": "subset" if scope == "subset" else "all"}

    if "verb" in modules:
        verb_cfg = config.get("verb") if isinstance(config.get("verb"), dict) else {}
        scope = verb_cfg.get("scope")
        normalized["verb"] = {"scope": "subset" if scope == "subset" else "all"}

    if "number" in modules:
        number_cfg = config.get("number") if isinstance(config.get("number"), dict) else {}
        try:
            max_number = int(number_cfg.get("max_number", learn.NUMBER_DEFAULT_MAX))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Največja številka ni veljavna.")
        if max_number < 0 or max_number > learn.NUMBER_MAX_LIMIT:
            raise HTTPException(
                status_code=400,
                detail=f"Največja številka mora biti ≤ {learn.NUMBER_MAX_LIMIT}.",
            )
        cycle_size = number_cfg.get("cycle_size")
        if cycle_size is not None:
            try:
                cycle_size = int(cycle_size)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Velikost cikla ni veljavna.")
            if cycle_size <= 0:
                raise HTTPException(status_code=400, detail="Velikost cikla mora biti vsaj 1.")
        use_components = bool(number_cfg.get("use_components", False))
        components = number_cfg.get("components")
        if use_components:
            if components is None:
                components = list(learn.NUMBER_COMPONENT_KEYS)
            if isinstance(components, str):
                components = [components]
            if not isinstance(components, list):
                components = []
            components = [comp for comp in components if comp in learn.NUMBER_COMPONENT_KEYS]
            if not components:
                raise HTTPException(status_code=400, detail="Izberi vsaj eno komponento.")
        else:
            components = None
        normalized["number"] = {
            "max_number": max_number,
            "cycle_size": cycle_size,
            "use_components": use_components,
            "components": components,
        }

    if "family" in modules:
        family_cfg = config.get("family") if isinstance(config.get("family"), dict) else {}
        levels = family_cfg.get("levels")
        if isinstance(levels, str):
            levels = [levels]
        if not isinstance(levels, list):
            levels = []
        levels = [level for level in levels if level in learn.FAMILY_LEVELS]
        if not levels:
            levels = list(learn.FAMILY_LEVELS)

        modes = family_cfg.get("modes")
        if isinstance(modes, str):
            modes = [modes]
        if not isinstance(modes, list):
            modes = []
        modes = [mode for mode in modes if mode in learn.FAMILY_MODES]
        if not modes:
            modes = list(learn.FAMILY_MODES)

        cases = family_cfg.get("cases")
        if isinstance(cases, str):
            cases = [cases]
        if not isinstance(cases, list):
            cases = []
        cases = [case for case in cases if case in learn.FAMILY_CASES]
        if "A2" not in levels:
            cases = ["nominative"]
        elif not cases:
            cases = list(learn.FAMILY_CASES)

        include_plural = bool(family_cfg.get("include_plural", True))
        normalized["family"] = {
            "levels": levels,
            "modes": modes,
            "cases": cases,
            "include_plural": include_plural,
        }

    return normalized


def _generate_access_code(conn: sqlite3.Connection, collection_id: int, version_number: int) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(12):
        suffix = "".join(random.choice(alphabet) for _ in range(4))
        code = f"C{collection_id}V{version_number}-{suffix}"
        row = conn.execute("SELECT 1 FROM collection_versions WHERE access_code = ?", (code,)).fetchone()
        if not row:
            return code
    raise HTTPException(status_code=500, detail="Ne morem ustvariti unikatne kode.")


def _build_item_record(word_type: str, translation: str, solutions: List[str]) -> tuple[str, str, str, str]:
    if word_type == "noun":
        if len(solutions) != 1 or not solutions[0]:
            raise HTTPException(status_code=400, detail="Samostalnik mora imeti zapis člena in besede.")
        records, errors = learn.build_noun_records([[solutions[0], translation]])
    else:
        if len(solutions) != 4 or any(not value for value in solutions):
            raise HTTPException(status_code=400, detail="Glagol mora imeti vse 4 oblike.")
        records, errors = learn.build_verb_records(
            [[solutions[0], solutions[1], solutions[2], solutions[3], translation]]
        )
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))
    return records[0]


def _fetch_item_proposal(conn: sqlite3.Connection, proposal_id: int) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT
            p.*,
            u.name AS proposer_name,
            r.name AS reviewer_name
        FROM item_proposals p
        JOIN users u ON u.id = p.proposer_user_id
        LEFT JOIN users r ON r.id = p.reviewer_user_id
        WHERE p.id = ?
        """,
        (proposal_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Predlog ne obstaja.")
    return row


def _create_item_proposal(
    conn: sqlite3.Connection,
    proposer_user_id: int,
    proposal_type: str,
    word_type: str,
    item_id: Optional[int],
    keyword: str,
    translation: str,
    solution_json: str,
    metadata_json: Optional[str],
) -> ItemProposalOut:
    now = learn.now_iso()
    cur = conn.execute(
        """
        INSERT INTO item_proposals (
            proposer_user_id,
            item_id,
            proposal_type,
            status,
            word_type,
            keyword,
            translation,
            solution_json,
            metadata_json,
            proposed_at
        )
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        """,
        (
            proposer_user_id,
            item_id,
            proposal_type,
            word_type,
            keyword,
            translation,
            solution_json,
            metadata_json,
            now,
        ),
    )
    conn.commit()
    row = _fetch_item_proposal(conn, cur.lastrowid)
    return serialize_proposal_row(row)


def _fetch_collection_version(
    conn: sqlite3.Connection, version_id: int
) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT
            cv.id AS version_id,
            cv.collection_id,
            cv.version_number,
            cv.title AS version_title,
            cv.description AS version_description,
            cv.config_json,
            cv.visibility,
            cv.access_code,
            cv.created_at,
            cv.published_at,
            c.owner_user_id,
            c.title AS collection_title,
            c.description AS collection_description,
            u.name AS owner_name
        FROM collection_versions cv
        JOIN collections c ON c.id = cv.collection_id
        JOIN users u ON u.id = c.owner_user_id
        WHERE cv.id = ?
        """,
        (version_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Zbirka ne obstaja.")
    return row


def _ensure_collection_access(row: sqlite3.Row, viewer_user_id: Optional[int] = None) -> None:
    if row["visibility"] != "draft":
        return
    if viewer_user_id and viewer_user_id == row["owner_user_id"]:
        return
    raise HTTPException(status_code=403, detail="Zbirka ni objavljena.")


def _load_collection_context(
    conn: sqlite3.Connection, collection_version_id: int, viewer_user_id: Optional[int]
) -> Dict[str, object]:
    version_row = _fetch_collection_version(conn, collection_version_id)
    _ensure_collection_access(version_row, viewer_user_id)
    raw_config = json.loads(version_row["config_json"]) if version_row["config_json"] else {}
    return {
        "row": version_row,
        "config": _normalize_collection_config(raw_config),
    }


def _version_row_to_out(row: sqlite3.Row) -> CollectionVersionOut:
    version_id = row["id"] if "id" in row.keys() else row["version_id"]
    title = row["title"] if "title" in row.keys() else row["version_title"]
    description = row["description"] if "description" in row.keys() else row["version_description"]
    config = json.loads(row["config_json"]) if row["config_json"] else {}
    return CollectionVersionOut(
        id=version_id,
        collection_id=row["collection_id"],
        version_number=row["version_number"],
        title=title,
        description=description,
        visibility=row["visibility"],
        access_code=row["access_code"],
        created_at=row["created_at"],
        published_at=row["published_at"],
        config=config,
    )


def _validate_item_ids(
    conn: sqlite3.Connection, word_type: str, item_ids: Optional[List[int]]
) -> List[int]:
    if not item_ids:
        return []
    unique_ids = list(dict.fromkeys(int(item_id) for item_id in item_ids))
    placeholders = ", ".join("?" * len(unique_ids))
    rows = conn.execute(
        f"SELECT id FROM items WHERE type = ? AND id IN ({placeholders})",
        tuple([word_type] + unique_ids),
    ).fetchall()
    if len(rows) != len(unique_ids):
        raise HTTPException(status_code=400, detail="Izbran seznam vsebuje neveljavne vnose.")
    return unique_ids


def _fetch_version_item_ids(
    conn: sqlite3.Connection, version_id: int, word_type: str
) -> List[int]:
    rows = conn.execute(
        """
        SELECT i.id
        FROM collection_version_items cvi
        JOIN items i ON i.id = cvi.item_id
        WHERE cvi.collection_version_id = ? AND i.type = ?
        ORDER BY i.id
        """,
        (version_id, word_type),
    ).fetchall()
    return [row["id"] for row in rows]


class UserCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class UserOut(BaseModel):
    id: int
    name: str
    created_at: str
    level: int


class UserUpdate(BaseModel):
    requester_user_id: int
    level: int = Field(..., ge=0, le=10)


class ModuleOut(BaseModel):
    type: WordType
    label: str
    description: str
    count: int


class CycleRequest(BaseModel):
    user_id: int
    word_type: WordType
    include_solutions: bool = False
    collection_version_id: Optional[int] = None
    max_number: Optional[int] = Field(default=None, ge=0)
    cycle_size: Optional[int] = Field(default=None, ge=1)
    number_components: Optional[List[NumberComponent]] = None
    family_levels: Optional[List[FamilyLevel]] = None
    family_cases: Optional[List[FamilyCase]] = None
    family_modes: Optional[List[FamilyMode]] = None
    family_include_plural: bool = True


class CycleItem(BaseModel):
    id: int
    translation: str
    labels: List[str]
    attempts: int
    accuracy: float
    streak: int
    difficulty: float
    solution: Optional[List[str]] = None


class CycleResponse(BaseModel):
    cycle_number: int
    adaptive: bool
    mode: str
    total_items: int
    items: List[CycleItem]


class CycleCompleteRequest(BaseModel):
    user_id: int
    word_type: WordType
    collection_version_id: Optional[int] = None


class AttemptRequest(BaseModel):
    user_id: int
    item_id: int
    word_type: WordType
    collection_version_id: Optional[int] = None
    answers: List[str] = Field(default_factory=list)
    revealed: bool = False
    cycle_number: Optional[int] = None
    show_solution: bool = False


class AttemptResponse(BaseModel):
    correct: bool
    revealed: bool
    solution: Optional[List[str]] = None


class ItemOut(BaseModel):
    id: int
    type: WordType
    translation: str
    metadata: Dict
    labels: List[str]
    solution: Optional[List[str]] = None
    attempts: Optional[int] = None
    correct: Optional[int] = None
    wrong: Optional[int] = None
    reveals: Optional[int] = None
    streak: Optional[int] = None


class StatsOut(BaseModel):
    user_id: int
    word_type: WordType
    attempts: int
    correct: int
    wrong: int
    reveals: int
    accuracy: float
    cycle_count: int


class ImportResult(BaseModel):
    added: int
    skipped: int
    errors: List[str]


class ItemCreate(BaseModel):
    type: WordType
    user_id: int
    translation: str
    solution: List[str]


class ItemUpdate(BaseModel):
    user_id: int
    translation: str
    solution: List[str]


class ItemProposalOut(BaseModel):
    id: int
    proposal_type: str
    status: str
    word_type: str
    item_id: Optional[int]
    keyword: str
    translation: str
    solution: List[str]
    metadata: Dict
    proposer_user_id: int
    proposer_name: str
    proposed_at: str
    reviewer_user_id: Optional[int]
    reviewer_name: Optional[str]
    reviewed_at: Optional[str]
    review_notes: Optional[str]


class ItemProposalReview(BaseModel):
    reviewer_user_id: int
    status: Literal["approved", "rejected"]
    review_notes: Optional[str] = None


class DeleteUserRequest(BaseModel):
    user_id: int


class CollectionCreate(BaseModel):
    owner_user_id: int
    title: str = Field(..., min_length=1, max_length=200)
    description: str = ""


class CollectionUpdate(BaseModel):
    owner_user_id: int
    title: Optional[str] = None
    description: Optional[str] = None


class CollectionOut(BaseModel):
    id: int
    owner_user_id: int
    title: str
    description: str
    created_at: str
    updated_at: str


class CollectionVersionCreate(BaseModel):
    owner_user_id: int
    title: Optional[str] = None
    description: str = ""
    visibility: CollectionVisibility = "draft"
    config: Dict[str, object] = Field(default_factory=dict)
    noun_item_ids: Optional[List[int]] = None
    verb_item_ids: Optional[List[int]] = None


class CollectionVersionUpdate(BaseModel):
    owner_user_id: int
    title: Optional[str] = None
    description: Optional[str] = None
    visibility: Optional[CollectionVisibility] = None
    config: Optional[Dict[str, object]] = None
    noun_item_ids: Optional[List[int]] = None
    verb_item_ids: Optional[List[int]] = None


class CollectionVersionOut(BaseModel):
    id: int
    collection_id: int
    version_number: int
    title: Optional[str]
    description: str
    visibility: CollectionVisibility
    access_code: Optional[str]
    created_at: str
    published_at: Optional[str]
    config: Dict[str, object]


class CollectionOwnerOut(BaseModel):
    collection: CollectionOut
    versions: List[CollectionVersionOut]


class CollectionPublicOut(BaseModel):
    collection_id: int
    title: str
    description: str
    owner_name: str
    version_id: int
    version_number: int
    version_title: Optional[str]
    version_description: str
    access_code: Optional[str]
    visibility: CollectionVisibility
    config: Dict[str, object]


class CollectionVersionItemsOut(BaseModel):
    noun_item_ids: List[int]
    verb_item_ids: List[int]


@app.get("/")
def root() -> Dict[str, str]:
    return {"message": "German Trainer API je pripravljen.", "db": str(learn.DB_PATH)}


@app.get("/users", response_model=List[UserOut])
def list_users(conn: sqlite3.Connection = Depends(get_db)) -> List[UserOut]:
    rows = conn.execute("SELECT id, name, created_at, level FROM users ORDER BY id").fetchall()
    return [
        UserOut(id=row["id"], name=row["name"], created_at=row["created_at"], level=row["level"] or 0)
        for row in rows
    ]


@app.post("/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, conn: sqlite3.Connection = Depends(get_db)) -> UserOut:
    user_id = learn.get_or_create_user(conn, payload.name.strip())
    row = conn.execute(
        "SELECT id, name, created_at, level FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return UserOut(
        id=row["id"],
        name=row["name"],
        created_at=row["created_at"],
        level=row["level"] or 0,
    )


@app.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, conn: sqlite3.Connection = Depends(get_db)) -> UserOut:
    row = conn.execute(
        "SELECT id, name, created_at, level FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Uporabnik ne obstaja.")
    return UserOut(
        id=row["id"],
        name=row["name"],
        created_at=row["created_at"],
        level=row["level"] or 0,
    )


@app.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, conn: sqlite3.Connection = Depends(get_db)) -> UserOut:
    ensure_admin(conn, payload.requester_user_id)
    ensure_user(conn, user_id)
    conn.execute("UPDATE users SET level = ? WHERE id = ?", (payload.level, user_id))
    conn.commit()
    row = conn.execute(
        "SELECT id, name, created_at, level FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return UserOut(
        id=row["id"],
        name=row["name"],
        created_at=row["created_at"],
        level=row["level"] or 0,
    )


@app.post("/collections", response_model=CollectionOut, status_code=201)
def create_collection(payload: CollectionCreate, conn: sqlite3.Connection = Depends(get_db)) -> CollectionOut:
    ensure_user(conn, payload.owner_user_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Naziv zbirke ne sme biti prazen.")
    description = payload.description.strip() if payload.description else ""
    now = learn.now_iso()
    cur = conn.execute(
        """
        INSERT INTO collections (owner_user_id, title, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (payload.owner_user_id, title, description, now, now),
    )
    conn.commit()
    collection_id = int(cur.lastrowid)
    return CollectionOut(
        id=collection_id,
        owner_user_id=payload.owner_user_id,
        title=title,
        description=description,
        created_at=now,
        updated_at=now,
    )


@app.get("/collections/owner/{user_id}", response_model=List[CollectionOwnerOut])
def list_owner_collections(
    user_id: int, conn: sqlite3.Connection = Depends(get_db)
) -> List[CollectionOwnerOut]:
    ensure_user(conn, user_id)
    collections = conn.execute(
        """
        SELECT id, owner_user_id, title, description, created_at, updated_at
        FROM collections
        WHERE owner_user_id = ?
        ORDER BY id
        """,
        (user_id,),
    ).fetchall()
    output: List[CollectionOwnerOut] = []
    for collection in collections:
        versions = conn.execute(
            """
            SELECT
                id,
                collection_id,
                version_number,
                title,
                description,
                config_json,
                visibility,
                access_code,
                created_at,
                published_at
            FROM collection_versions
            WHERE collection_id = ?
            ORDER BY version_number DESC
            """,
            (collection["id"],),
        ).fetchall()
        version_items = [_version_row_to_out(row) for row in versions]
        output.append(
            CollectionOwnerOut(
                collection=CollectionOut(
                    id=collection["id"],
                    owner_user_id=collection["owner_user_id"],
                    title=collection["title"],
                    description=collection["description"],
                    created_at=collection["created_at"],
                    updated_at=collection["updated_at"],
                ),
                versions=version_items,
            )
        )
    return output


@app.patch("/collections/{collection_id}", response_model=CollectionOut)
def update_collection(
    collection_id: int,
    payload: CollectionUpdate,
    conn: sqlite3.Connection = Depends(get_db),
) -> CollectionOut:
    ensure_user(conn, payload.owner_user_id)
    row = conn.execute(
        """
        SELECT id, owner_user_id, title, description, created_at, updated_at
        FROM collections
        WHERE id = ?
        """,
        (collection_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Zbirka ne obstaja.")
    if row["owner_user_id"] != payload.owner_user_id:
        raise HTTPException(status_code=403, detail="Nimaš pravic za urejanje zbirke.")
    fields: List[str] = []
    params: List[object] = []
    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Naziv zbirke ne sme biti prazen.")
        fields.append("title = ?")
        params.append(title)
    if payload.description is not None:
        fields.append("description = ?")
        params.append(payload.description.strip())
    if not fields:
        return CollectionOut(
            id=row["id"],
            owner_user_id=row["owner_user_id"],
            title=row["title"],
            description=row["description"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
    now = learn.now_iso()
    fields.append("updated_at = ?")
    params.append(now)
    params.append(collection_id)
    conn.execute(
        f"UPDATE collections SET {', '.join(fields)} WHERE id = ?",
        tuple(params),
    )
    conn.commit()
    refreshed = conn.execute(
        """
        SELECT id, owner_user_id, title, description, created_at, updated_at
        FROM collections
        WHERE id = ?
        """,
        (collection_id,),
    ).fetchone()
    return CollectionOut(
        id=refreshed["id"],
        owner_user_id=refreshed["owner_user_id"],
        title=refreshed["title"],
        description=refreshed["description"],
        created_at=refreshed["created_at"],
        updated_at=refreshed["updated_at"],
    )


@app.get("/collections/public", response_model=List[CollectionPublicOut])
def list_public_collections(conn: sqlite3.Connection = Depends(get_db)) -> List[CollectionPublicOut]:
    rows = conn.execute(
        """
        SELECT
            c.id AS collection_id,
            c.title,
            c.description,
            u.name AS owner_name,
            cv.id AS version_id,
            cv.version_number,
            cv.title AS version_title,
            cv.description AS version_description,
            cv.visibility,
            cv.access_code,
            cv.config_json
        FROM collections c
        JOIN users u ON u.id = c.owner_user_id
        JOIN collection_versions cv ON cv.collection_id = c.id
        WHERE cv.visibility = 'public'
          AND cv.version_number = (
            SELECT MAX(version_number)
            FROM collection_versions v2
            WHERE v2.collection_id = c.id AND v2.visibility = 'public'
          )
        ORDER BY c.id
        """
    ).fetchall()
    output: List[CollectionPublicOut] = []
    for row in rows:
        config = json.loads(row["config_json"]) if row["config_json"] else {}
        output.append(
            CollectionPublicOut(
                collection_id=row["collection_id"],
                title=row["title"],
                description=row["description"],
                owner_name=row["owner_name"],
                version_id=row["version_id"],
                version_number=row["version_number"],
                version_title=row["version_title"],
                version_description=row["version_description"],
                access_code=row["access_code"],
                visibility=row["visibility"],
                config=config,
            )
        )
    return output


@app.get("/collections/versions/{version_id}", response_model=CollectionVersionOut)
def get_collection_version(
    version_id: int,
    viewer_user_id: Optional[int] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> CollectionVersionOut:
    row = _fetch_collection_version(conn, version_id)
    _ensure_collection_access(row, viewer_user_id)
    return _version_row_to_out(row)


@app.get("/collections/versions/{version_id}/items", response_model=CollectionVersionItemsOut)
def get_collection_version_items(
    version_id: int,
    owner_user_id: int = Query(...),
    conn: sqlite3.Connection = Depends(get_db),
) -> CollectionVersionItemsOut:
    ensure_user(conn, owner_user_id)
    row = _fetch_collection_version(conn, version_id)
    if row["owner_user_id"] != owner_user_id:
        raise HTTPException(status_code=403, detail="Nimaš pravic za urejanje zbirke.")
    noun_item_ids = _fetch_version_item_ids(conn, version_id, "noun")
    verb_item_ids = _fetch_version_item_ids(conn, version_id, "verb")
    return CollectionVersionItemsOut(
        noun_item_ids=noun_item_ids,
        verb_item_ids=verb_item_ids,
    )


@app.get("/collections/code/{access_code}", response_model=CollectionPublicOut)
def resolve_collection_code(
    access_code: str, conn: sqlite3.Connection = Depends(get_db)
) -> CollectionPublicOut:
    code = access_code.strip().upper()
    row = conn.execute(
        """
        SELECT
            c.id AS collection_id,
            c.title,
            c.description,
            u.name AS owner_name,
            cv.id AS version_id,
            cv.version_number,
            cv.title AS version_title,
            cv.description AS version_description,
            cv.visibility,
            cv.access_code,
            cv.config_json
        FROM collection_versions cv
        JOIN collections c ON c.id = cv.collection_id
        JOIN users u ON u.id = c.owner_user_id
        WHERE cv.access_code = ? AND cv.visibility IN ('public', 'unlisted')
        """,
        (code,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Koda ne obstaja.")
    config = json.loads(row["config_json"]) if row["config_json"] else {}
    return CollectionPublicOut(
        collection_id=row["collection_id"],
        title=row["title"],
        description=row["description"],
        owner_name=row["owner_name"],
        version_id=row["version_id"],
        version_number=row["version_number"],
        version_title=row["version_title"],
        version_description=row["version_description"],
        access_code=row["access_code"],
        visibility=row["visibility"],
        config=config,
    )


@app.post("/collections/{collection_id}/versions", response_model=CollectionVersionOut, status_code=201)
def create_collection_version(
    collection_id: int,
    payload: CollectionVersionCreate,
    conn: sqlite3.Connection = Depends(get_db),
) -> CollectionVersionOut:
    ensure_user(conn, payload.owner_user_id)
    collection = conn.execute(
        "SELECT owner_user_id FROM collections WHERE id = ?",
        (collection_id,),
    ).fetchone()
    if not collection:
        raise HTTPException(status_code=404, detail="Zbirka ne obstaja.")
    if collection["owner_user_id"] != payload.owner_user_id:
        raise HTTPException(status_code=403, detail="Nimaš pravic za urejanje zbirke.")
    normalized_config = _normalize_collection_config(payload.config)
    modules = normalized_config.get("modules", [])
    noun_scope = normalized_config.get("noun", {}).get("scope", "all")
    verb_scope = normalized_config.get("verb", {}).get("scope", "all")
    if "noun" not in modules and payload.noun_item_ids:
        raise HTTPException(status_code=400, detail="Samostalniki niso del zbirke.")
    if "verb" not in modules and payload.verb_item_ids:
        raise HTTPException(status_code=400, detail="Glagoli niso del zbirke.")
    noun_item_ids = _validate_item_ids(conn, "noun", payload.noun_item_ids)
    verb_item_ids = _validate_item_ids(conn, "verb", payload.verb_item_ids)
    if "noun" in modules and noun_scope == "subset" and not noun_item_ids:
        raise HTTPException(status_code=400, detail="Izberi vsaj en samostalnik.")
    if "verb" in modules and verb_scope == "subset" and not verb_item_ids:
        raise HTTPException(status_code=400, detail="Izberi vsaj en glagol.")
    if "noun" in modules and noun_scope != "subset" and noun_item_ids:
        raise HTTPException(status_code=400, detail="Samostalniki so nastavljeni na 'vsi'.")
    if "verb" in modules and verb_scope != "subset" and verb_item_ids:
        raise HTTPException(status_code=400, detail="Glagoli so nastavljeni na 'vsi'.")
    version_row = conn.execute(
        "SELECT COALESCE(MAX(version_number), 0) AS v FROM collection_versions WHERE collection_id = ?",
        (collection_id,),
    ).fetchone()
    version_number = int(version_row["v"] or 0) + 1
    access_code = _generate_access_code(conn, collection_id, version_number)
    now = learn.now_iso()
    published_at = now if payload.visibility != "draft" else None
    title = payload.title.strip() if payload.title else None
    description = payload.description.strip() if payload.description else ""
    cur = conn.execute(
        """
        INSERT INTO collection_versions (
            collection_id,
            version_number,
            title,
            description,
            config_json,
            visibility,
            access_code,
            created_at,
            published_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            collection_id,
            version_number,
            title,
            description,
            json.dumps(normalized_config),
            payload.visibility,
            access_code,
            now,
            published_at,
        ),
    )
    conn.execute(
        "UPDATE collections SET updated_at = ? WHERE id = ?",
        (now, collection_id),
    )
    if noun_item_ids:
        conn.executemany(
            "INSERT INTO collection_version_items (collection_version_id, item_id) VALUES (?, ?)",
            [(cur.lastrowid, item_id) for item_id in noun_item_ids],
        )
    if verb_item_ids:
        conn.executemany(
            "INSERT INTO collection_version_items (collection_version_id, item_id) VALUES (?, ?)",
            [(cur.lastrowid, item_id) for item_id in verb_item_ids],
        )
    conn.commit()
    version_id = int(cur.lastrowid)
    row = conn.execute(
        """
        SELECT
            id,
            collection_id,
            version_number,
            title,
            description,
            config_json,
            visibility,
            access_code,
            created_at,
            published_at
        FROM collection_versions
        WHERE id = ?
        """,
        (version_id,),
    ).fetchone()
    return _version_row_to_out(row)


@app.patch("/collections/versions/{version_id}", response_model=CollectionVersionOut)
def update_collection_version(
    version_id: int,
    payload: CollectionVersionUpdate,
    conn: sqlite3.Connection = Depends(get_db),
) -> CollectionVersionOut:
    ensure_user(conn, payload.owner_user_id)
    row = _fetch_collection_version(conn, version_id)
    if row["owner_user_id"] != payload.owner_user_id:
        raise HTTPException(status_code=403, detail="Nimaš pravic za urejanje zbirke.")
    current_config = _normalize_collection_config(
        json.loads(row["config_json"]) if row["config_json"] else {}
    )
    config = current_config
    if payload.config is not None:
        config = _normalize_collection_config(payload.config)
    modules = config.get("modules", [])
    noun_scope = config.get("noun", {}).get("scope", "all")
    verb_scope = config.get("verb", {}).get("scope", "all")
    noun_item_ids: Optional[List[int]] = None
    verb_item_ids: Optional[List[int]] = None
    if payload.noun_item_ids is not None:
        if "noun" not in modules:
            raise HTTPException(status_code=400, detail="Samostalniki niso del zbirke.")
        if noun_scope != "subset":
            raise HTTPException(status_code=400, detail="Samostalniki so nastavljeni na 'vsi'.")
        noun_item_ids = _validate_item_ids(conn, "noun", payload.noun_item_ids)
        if not noun_item_ids:
            raise HTTPException(status_code=400, detail="Izberi vsaj en samostalnik.")
    elif payload.config is not None and "noun" in modules and noun_scope == "subset":
        raise HTTPException(status_code=400, detail="Izberi vsaj en samostalnik.")
    if payload.verb_item_ids is not None:
        if "verb" not in modules:
            raise HTTPException(status_code=400, detail="Glagoli niso del zbirke.")
        if verb_scope != "subset":
            raise HTTPException(status_code=400, detail="Glagoli so nastavljeni na 'vsi'.")
        verb_item_ids = _validate_item_ids(conn, "verb", payload.verb_item_ids)
        if not verb_item_ids:
            raise HTTPException(status_code=400, detail="Izberi vsaj en glagol.")
    elif payload.config is not None and "verb" in modules and verb_scope == "subset":
        raise HTTPException(status_code=400, detail="Izberi vsaj en glagol.")

    fields: List[str] = []
    params: List[object] = []
    if payload.title is not None:
        fields.append("title = ?")
        params.append(payload.title.strip())
    if payload.description is not None:
        fields.append("description = ?")
        params.append(payload.description.strip())
    if payload.visibility is not None:
        fields.append("visibility = ?")
        params.append(payload.visibility)
        if payload.visibility != "draft" and not row["published_at"]:
            fields.append("published_at = ?")
            params.append(learn.now_iso())
    if payload.config is not None:
        fields.append("config_json = ?")
        params.append(json.dumps(config))
    item_updates = noun_item_ids is not None or verb_item_ids is not None
    if payload.config is not None and (noun_scope == "all" or verb_scope == "all"):
        item_updates = True
    if fields:
        params.append(version_id)
        conn.execute(
            f"UPDATE collection_versions SET {', '.join(fields)} WHERE id = ?",
            tuple(params),
        )
    elif not item_updates:
        return _version_row_to_out(row)
    if payload.config is not None and noun_scope == "all":
        conn.execute(
            """
            DELETE FROM collection_version_items
            WHERE collection_version_id = ?
              AND item_id IN (SELECT id FROM items WHERE type = 'noun')
            """,
            (version_id,),
        )
    if payload.config is not None and verb_scope == "all":
        conn.execute(
            """
            DELETE FROM collection_version_items
            WHERE collection_version_id = ?
              AND item_id IN (SELECT id FROM items WHERE type = 'verb')
            """,
            (version_id,),
        )
    if noun_item_ids is not None:
        conn.execute(
            """
            DELETE FROM collection_version_items
            WHERE collection_version_id = ?
              AND item_id IN (SELECT id FROM items WHERE type = 'noun')
            """,
            (version_id,),
        )
        conn.executemany(
            "INSERT INTO collection_version_items (collection_version_id, item_id) VALUES (?, ?)",
            [(version_id, item_id) for item_id in noun_item_ids],
        )
    if verb_item_ids is not None:
        conn.execute(
            """
            DELETE FROM collection_version_items
            WHERE collection_version_id = ?
              AND item_id IN (SELECT id FROM items WHERE type = 'verb')
            """,
            (version_id,),
        )
        conn.executemany(
            "INSERT INTO collection_version_items (collection_version_id, item_id) VALUES (?, ?)",
            [(version_id, item_id) for item_id in verb_item_ids],
        )
    conn.execute(
        "UPDATE collections SET updated_at = ? WHERE id = ?",
        (learn.now_iso(), row["collection_id"]),
    )
    conn.commit()
    refreshed = conn.execute(
        """
        SELECT
            id,
            collection_id,
            version_number,
            title,
            description,
            config_json,
            visibility,
            access_code,
            created_at,
            published_at
        FROM collection_versions
        WHERE id = ?
        """,
        (version_id,),
    ).fetchone()
    return _version_row_to_out(refreshed)


@app.get("/modules", response_model=List[ModuleOut])
def list_modules(
    collection_version_id: Optional[int] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> List[ModuleOut]:
    learn.ensure_family_seed(conn)
    if collection_version_id is None:
        rows = conn.execute("SELECT type, COUNT(*) AS cnt FROM items GROUP BY type").fetchall()
        counts = {row["type"]: row["cnt"] for row in rows}
        family_count_row = conn.execute("SELECT COUNT(*) AS cnt FROM family_items").fetchone()
        family_count = family_count_row["cnt"] if family_count_row else 0
        return [
            ModuleOut(
                type="noun",
                label="Samostalniki",
                description="",
                count=counts.get("noun", 0),
            ),
            ModuleOut(
                type="verb",
                label="Nepravilni glagoli",
                description="",
                count=counts.get("verb", 0),
            ),
            ModuleOut(
                type="number",
                label="Števila",
                description="Zapis števil po nemško.",
                count=0,
            ),
            ModuleOut(
                type="family",
                label="Družina",
                description="Družinski člani, plural in fraze.",
                count=family_count,
            ),
        ]

    version_row = _fetch_collection_version(conn, collection_version_id)
    config = _normalize_collection_config(
        json.loads(version_row["config_json"]) if version_row["config_json"] else {}
    )
    modules = config.get("modules", list(ALLOWED_MODULES))
    counts: Dict[str, int] = {}
    for module in modules:
        if module in ("noun", "verb"):
            scope = config.get(module, {}).get("scope", "all")
            if scope == "subset":
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS cnt
                    FROM collection_version_items cvi
                    JOIN items i ON i.id = cvi.item_id
                    WHERE cvi.collection_version_id = ? AND i.type = ?
                    """,
                    (collection_version_id, module),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM items WHERE type = ?",
                    (module,),
                ).fetchone()
            counts[module] = row["cnt"] if row else 0
        elif module == "family":
            family_levels = config.get("family", {}).get("levels", list(learn.FAMILY_LEVELS))
            placeholders = ", ".join("?" * len(family_levels))
            row = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM family_items WHERE level IN ({placeholders})",
                tuple(family_levels),
            ).fetchone()
            counts[module] = row["cnt"] if row else 0
        else:
            counts[module] = 0

    output: List[ModuleOut] = []
    for module in modules:
        if module == "noun":
            output.append(
                ModuleOut(
                    type="noun",
                    label="Samostalniki",
                    description="",
                    count=counts.get("noun", 0),
                )
            )
        elif module == "verb":
            output.append(
                ModuleOut(
                    type="verb",
                    label="Nepravilni glagoli",
                    description="",
                    count=counts.get("verb", 0),
                )
            )
        elif module == "number":
            output.append(
                ModuleOut(
                    type="number",
                    label="Števila",
                    description="Zapis števil po nemško.",
                    count=0,
                )
            )
        elif module == "family":
            output.append(
                ModuleOut(
                    type="family",
                    label="Družina",
                    description="Družinski člani, plural in fraze.",
                    count=counts.get("family", 0),
                )
            )
    return output


@app.post("/cycles", response_model=CycleResponse)
def start_cycle(payload: CycleRequest, conn: sqlite3.Connection = Depends(get_db)) -> CycleResponse:
    ensure_user(conn, payload.user_id)
    collection_version_id = payload.collection_version_id
    collection_config: Optional[Dict[str, object]] = None
    if collection_version_id is not None:
        collection_ctx = _load_collection_context(conn, collection_version_id, payload.user_id)
        collection_config = collection_ctx["config"]
        allowed_modules = collection_config.get("modules", [])
        if payload.word_type not in allowed_modules:
            raise HTTPException(status_code=400, detail="Sklop ni del izbrane zbirke.")
    if payload.word_type == "number":
        if collection_config:
            number_cfg = collection_config.get("number", {})
            max_number = int(number_cfg.get("max_number", learn.NUMBER_DEFAULT_MAX))
            cycle_size = number_cfg.get("cycle_size")
            components = number_cfg.get("components") if number_cfg.get("use_components") else None
        else:
            max_number = payload.max_number if payload.max_number is not None else learn.NUMBER_DEFAULT_MAX
            if max_number > learn.NUMBER_MAX_LIMIT:
                raise HTTPException(
                    status_code=400,
                    detail=f"Največja številka mora biti ≤ {learn.NUMBER_MAX_LIMIT}.",
                )
            cycle_size = payload.cycle_size
            components = payload.number_components
            if components is not None and len(components) == 0:
                raise HTTPException(status_code=400, detail="Izberi vsaj eno komponento.")
        if components:
            components = list(dict.fromkeys(components))
        cycle_index = learn.fetch_number_cycle_count(conn, payload.user_id, collection_version_id) + 1
        total_attempts, accuracy = learn.global_number_accuracy(conn, payload.user_id, collection_version_id)
        adaptive = (
            cycle_index > learn.ADAPTIVE_AFTER_CYCLES
            or (total_attempts >= learn.MIN_ATTEMPTS_FOR_ADAPTIVE and accuracy >= learn.HIGH_ACCURACY_THRESHOLD)
        )
        stats_map = learn.fetch_number_stats(conn, payload.user_id, max_number, collection_version_id)
        selected_numbers = learn.choose_number_cycle_numbers(
            max_number,
            stats_map,
            adaptive,
            cycle_size=cycle_size,
            components=components,
        )
        if not selected_numbers:
            raise HTTPException(status_code=404, detail="Ni števil za ta razpon.")
        questions = []
        labels = learn.get_labels("number", {})
        for number in selected_numbers:
            stats = stats_map.get(number)
            item_stats = learn.build_number_item(number, stats)
            question = CycleItem(
                id=item_stats["id"],
                translation=item_stats["translation"],
                labels=labels,
                attempts=item_stats["attempts"],
                accuracy=item_stats["accuracy"],
                streak=item_stats["streak"],
                difficulty=item_stats["difficulty"],
                solution=[learn.number_to_german(number)] if payload.include_solutions else None,
            )
            questions.append(question)
        mode_note = "adaptivni način" if adaptive else "naključni način"
        return CycleResponse(
            cycle_number=cycle_index,
            adaptive=adaptive,
            mode=mode_note,
            total_items=len(questions),
            items=questions,
        )

    if payload.word_type == "family":
        learn.ensure_family_seed(conn)
        if collection_config:
            family_cfg = collection_config.get("family", {})
            levels = list(family_cfg.get("levels", ["A1"]))
            modes = list(family_cfg.get("modes", ["noun", "phrase"]))
            cases = list(family_cfg.get("cases", ["nominative"]))
            include_plural = bool(family_cfg.get("include_plural", True))
        else:
            levels = payload.family_levels or ["A1"]
            modes = payload.family_modes or ["noun", "phrase"]
            cases = payload.family_cases or ["nominative"]
            include_plural = payload.family_include_plural
        if not levels:
            raise HTTPException(status_code=400, detail="Izberi vsaj eno stopnjo.")
        if not modes:
            raise HTTPException(status_code=400, detail="Izberi vsaj en način vadbe.")
        if "A2" not in levels:
            cases = ["nominative"]
        if "phrase" in modes and not cases:
            raise HTTPException(status_code=400, detail="Izberi vsaj en sklon.")
        cycle_index = learn.fetch_family_cycle_count(conn, payload.user_id, collection_version_id) + 1
        total_attempts, accuracy = learn.global_family_accuracy(conn, payload.user_id, collection_version_id)
        adaptive = (
            cycle_index > learn.ADAPTIVE_AFTER_CYCLES
            or (total_attempts >= learn.MIN_ATTEMPTS_FOR_ADAPTIVE and accuracy >= learn.HIGH_ACCURACY_THRESHOLD)
        )
        items = learn.fetch_family_cards_with_stats(
            conn,
            payload.user_id,
            levels,
            modes,
            cases,
            include_plural=include_plural,
            collection_version_id=collection_version_id,
        )
        if not items:
            raise HTTPException(status_code=404, detail="Ni kartic za izbrane nastavitve.")
        selected = learn.choose_family_cycle_items(items, adaptive)
        questions = []
        for item in selected:
            question = CycleItem(
                id=item["id"],
                translation=item["translation"],
                labels=item["labels"],
                attempts=item["attempts"],
                accuracy=item["accuracy"],
                streak=item["streak"],
                difficulty=item["difficulty"],
                solution=item["solutions"] if payload.include_solutions else None,
            )
            questions.append(question)
        mode_note = "adaptivni način" if adaptive else "naključni način"
        return CycleResponse(
            cycle_number=cycle_index,
            adaptive=adaptive,
            mode=mode_note,
            total_items=len(questions),
            items=questions,
        )

    restrict_items = False
    if collection_config:
        scope = collection_config.get(payload.word_type, {}).get("scope", "all")
        restrict_items = scope == "subset"
    cycle_index = learn.fetch_cycle_count(
        conn,
        payload.user_id,
        payload.word_type,
        collection_version_id=collection_version_id,
    ) + 1
    total_attempts, accuracy = learn.global_accuracy(
        conn,
        payload.user_id,
        payload.word_type,
        collection_version_id=collection_version_id,
        restrict_to_collection_items=restrict_items,
    )
    adaptive = (
        cycle_index > learn.ADAPTIVE_AFTER_CYCLES
        or (total_attempts >= learn.MIN_ATTEMPTS_FOR_ADAPTIVE and accuracy >= learn.HIGH_ACCURACY_THRESHOLD)
    )

    items = learn.fetch_items_with_stats(
        conn,
        payload.user_id,
        payload.word_type,
        collection_version_id=collection_version_id,
        restrict_to_collection_items=restrict_items,
    )
    if not items:
        raise HTTPException(status_code=404, detail="Ni kartic za ta sklop.")

    selected = learn.choose_cycle_items(items, adaptive)
    if not selected:
        selected = items
    questions = []
    for item in selected:
        labels = learn.get_labels(payload.word_type, item["metadata"])
        question = CycleItem(
            id=item["id"],
            translation=item["translation"],
            labels=labels,
            attempts=item["attempts"],
            accuracy=item["accuracy"],
            streak=item["streak"],
            difficulty=item["difficulty"],
            solution=item["solutions"] if payload.include_solutions else None,
        )
        questions.append(question)
    mode_note = "adaptivni način" if adaptive else "naključni način"
    return CycleResponse(
        cycle_number=cycle_index,
        adaptive=adaptive,
        mode=mode_note,
        total_items=len(questions),
        items=questions,
    )


@app.post("/cycles/complete")
def complete_cycle(payload: CycleCompleteRequest, conn: sqlite3.Connection = Depends(get_db)) -> Dict[str, str]:
    ensure_user(conn, payload.user_id)
    collection_version_id = payload.collection_version_id
    if collection_version_id is not None:
        _load_collection_context(conn, collection_version_id, payload.user_id)
    if payload.word_type == "number":
        learn.increment_number_cycle(conn, payload.user_id, collection_version_id)
    elif payload.word_type == "family":
        learn.increment_family_cycle(conn, payload.user_id, collection_version_id)
    else:
        learn.increment_cycle(conn, payload.user_id, payload.word_type, collection_version_id)
    return {"status": "ok"}


@app.post("/attempts", response_model=AttemptResponse)
def submit_attempt(payload: AttemptRequest, conn: sqlite3.Connection = Depends(get_db)) -> AttemptResponse:
    ensure_user(conn, payload.user_id)
    collection_version_id = payload.collection_version_id
    collection_config: Optional[Dict[str, object]] = None
    if collection_version_id is not None:
        collection_ctx = _load_collection_context(conn, collection_version_id, payload.user_id)
        collection_config = collection_ctx["config"]
        allowed_modules = collection_config.get("modules", [])
        if payload.word_type not in allowed_modules:
            raise HTTPException(status_code=400, detail="Sklop ni del izbrane zbirke.")
    if payload.word_type == "number":
        number = payload.item_id
        if collection_config:
            max_number = int(collection_config.get("number", {}).get("max_number", learn.NUMBER_DEFAULT_MAX))
        else:
            max_number = learn.NUMBER_MAX_LIMIT
        if number < 0 or number > max_number:
            raise HTTPException(status_code=400, detail="Število je izven dovoljenega razpona.")
        solutions = [learn.number_to_german(number)]
        correct = learn.check_answers(
            payload.answers,
            solutions,
            allow_umlaut_fallback=True,
            collapse_spaces=False,
        )
        effective_correct = bool(correct and not payload.revealed)
        cycle_number = payload.cycle_number or (
            learn.fetch_number_cycle_count(conn, payload.user_id, collection_version_id) + 1
        )
        learn.update_number_progress(
            conn=conn,
            user_id=payload.user_id,
            number=number,
            correct=effective_correct,
            revealed=payload.revealed,
            answers=payload.answers,
            cycle_number=cycle_number,
            collection_version_id=collection_version_id,
        )
        solution_payload = solutions if (payload.show_solution or payload.revealed) else None
        return AttemptResponse(correct=effective_correct, revealed=payload.revealed, solution=solution_payload)

    if payload.word_type == "family":
        learn.ensure_family_seed(conn)
        card = learn.fetch_family_card(conn, payload.item_id)
        if not card:
            raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
        if collection_config:
            family_cfg = collection_config.get("family", {})
            levels = family_cfg.get("levels", [])
            modes = family_cfg.get("modes", [])
            cases = family_cfg.get("cases", [])
            if card["level"] not in levels or card["mode"] not in modes:
                raise HTTPException(status_code=400, detail="Kartica ni del izbrane zbirke.")
            if card["mode"] == "phrase" and card["case_name"] not in cases:
                raise HTTPException(status_code=400, detail="Kartica ni del izbrane zbirke.")
        _, _, solutions = learn.build_family_card_payload(card)
        correct = learn.check_answers(payload.answers, solutions, allow_umlaut_fallback=True)
        effective_correct = bool(correct and not payload.revealed)
        cycle_number = payload.cycle_number or (
            learn.fetch_family_cycle_count(conn, payload.user_id, collection_version_id) + 1
        )
        learn.update_family_progress(
            conn=conn,
            user_id=payload.user_id,
            card_id=payload.item_id,
            correct=effective_correct,
            revealed=payload.revealed,
            answers=payload.answers,
            cycle_number=cycle_number,
            collection_version_id=collection_version_id,
        )
        solution_payload = solutions if (payload.show_solution or payload.revealed) else None
        return AttemptResponse(correct=effective_correct, revealed=payload.revealed, solution=solution_payload)

    row = conn.execute(
        "SELECT id, type, solution_json FROM items WHERE id = ?", (payload.item_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
    if row["type"] != payload.word_type:
        raise HTTPException(status_code=400, detail="Vrsta besede se ne ujema z vnosom.")
    if collection_config and collection_config.get(payload.word_type, {}).get("scope") == "subset":
        mapping = conn.execute(
            """
            SELECT 1
            FROM collection_version_items
            WHERE collection_version_id = ? AND item_id = ?
            """,
            (collection_version_id, payload.item_id),
        ).fetchone()
        if not mapping:
            raise HTTPException(status_code=400, detail="Vnos ni del izbrane zbirke.")

    solutions = json.loads(row["solution_json"])
    correct = learn.check_answers(payload.answers, solutions)
    effective_correct = bool(correct and not payload.revealed)
    cycle_number = payload.cycle_number or (
        learn.fetch_cycle_count(conn, payload.user_id, payload.word_type, collection_version_id) + 1
    )
    learn.update_progress(
        conn=conn,
        user_id=payload.user_id,
        item_id=payload.item_id,
        correct=effective_correct,
        revealed=payload.revealed,
        answers=payload.answers,
        cycle_number=cycle_number,
        collection_version_id=collection_version_id,
    )
    solution_payload = solutions if (payload.show_solution or payload.revealed) else None
    return AttemptResponse(correct=effective_correct, revealed=payload.revealed, solution=solution_payload)


@app.get("/items", response_model=List[ItemOut])
def browse_items(
    word_type: Optional[WordType] = Query(default=None),
    include_solution: bool = Query(default=False),
    user_id: Optional[int] = Query(default=None),
    collection_version_id: Optional[int] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> List[ItemOut]:
    if word_type == "number":
        raise HTTPException(status_code=400, detail="Števil ni mogoče brskati kot seznam vnosov.")
    if word_type == "family":
        raise HTTPException(status_code=400, detail="Družinskih kartic ni mogoče brskati kot seznam vnosov.")
    if collection_version_id is not None:
        if not word_type:
            raise HTTPException(status_code=400, detail="Sklop je obvezen za zbirke.")
        collection_ctx = _load_collection_context(conn, collection_version_id, user_id or 0)
        config = collection_ctx["config"]
        if word_type not in config.get("modules", []):
            raise HTTPException(status_code=400, detail="Sklop ni del izbrane zbirke.")
        scope = config.get(word_type, {}).get("scope", "all")
        items = learn.fetch_items_with_stats(
            conn,
            user_id or 0,
            word_type,
            collection_version_id=collection_version_id,
            restrict_to_collection_items=scope == "subset",
        )
        output: List[ItemOut] = []
        for item in items:
            labels = learn.get_labels(word_type, item.get("metadata", {}))
            output.append(
                ItemOut(
                    id=item["id"],
                    type=word_type,
                    translation=item["translation"],
                    metadata=item.get("metadata", {}),
                    labels=labels,
                    solution=item["solutions"] if include_solution else None,
                    attempts=item["attempts"],
                    correct=item["correct"],
                    wrong=item["wrong"],
                    reveals=item["reveals"],
                    streak=item["streak"],
                )
            )
        return output
    query = """
    SELECT
        items.id,
        items.type,
        items.translation,
        items.solution_json,
        items.metadata_json,
        COALESCE(us.attempts, 0) AS attempts,
        COALESCE(us.correct, 0) AS correct,
        COALESCE(us.wrong, 0) AS wrong,
        COALESCE(us.reveals, 0) AS reveals,
        COALESCE(us.correct_streak, 0) AS streak
    FROM items
    LEFT JOIN user_stats us
      ON us.entry_id = items.id AND us.user_id = ?
    """
    params: List = [user_id]  # if user_id is None, this will produce NULL and COALESCE => 0
    if word_type:
        query += " WHERE items.type = ?"
        params.append(word_type)
    query += " ORDER BY items.id"
    rows = conn.execute(query, tuple(params)).fetchall()
    items: List[ItemOut] = []
    for row in rows:
        items.append(serialize_item_row(row, include_solution=include_solution))
    return items


@app.get("/numbers/results", response_model=List[ItemOut])
def number_results(
    user_id: int = Query(...),
    include_solution: bool = Query(default=False),
    max_number: Optional[int] = Query(default=None, ge=0),
    collection_version_id: Optional[int] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> List[ItemOut]:
    ensure_user(conn, user_id)
    if collection_version_id is not None:
        collection_ctx = _load_collection_context(conn, collection_version_id, user_id)
        config = collection_ctx["config"]
        if "number" not in config.get("modules", []):
            raise HTTPException(status_code=400, detail="Sklop ni del izbrane zbirke.")
        max_number = int(config.get("number", {}).get("max_number", learn.NUMBER_DEFAULT_MAX))
        query = """
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
        """
        params: List = [user_id, collection_version_id, max_number]
    else:
        if max_number is not None and max_number > learn.NUMBER_MAX_LIMIT:
            raise HTTPException(
                status_code=400,
                detail=f"Največja številka mora biti ≤ {learn.NUMBER_MAX_LIMIT}.",
            )
        query = """
        SELECT
            number,
            attempts,
            correct,
            wrong,
            reveals,
            correct_streak,
            last_seen
        FROM number_stats
        WHERE user_id = ?
        """
        params = [user_id]
        if max_number is not None:
            query += " AND number <= ?"
            params.append(max_number)
    rows = conn.execute(query, tuple(params)).fetchall()
    labels = learn.get_labels("number", {})
    items: List[ItemOut] = []
    for row in rows:
        number_value = int(row["number"])
        solution = [learn.number_to_german(number_value)] if include_solution else None
        items.append(
            ItemOut(
                id=number_value,
                type="number",
                translation=str(number_value),
                metadata={},
                labels=labels,
                solution=solution,
                attempts=row["attempts"],
                correct=row["correct"],
                wrong=row["wrong"],
                reveals=row["reveals"],
                streak=row["correct_streak"],
            )
        )
    return items


@app.get("/family/results", response_model=List[ItemOut])
def family_results(
    user_id: int = Query(...),
    include_solution: bool = Query(default=False),
    levels: Optional[List[FamilyLevel]] = Query(default=None),
    cases: Optional[List[FamilyCase]] = Query(default=None),
    modes: Optional[List[FamilyMode]] = Query(default=None),
    include_plural: bool = Query(default=True),
    collection_version_id: Optional[int] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> List[ItemOut]:
    ensure_user(conn, user_id)
    learn.ensure_family_seed(conn)
    if collection_version_id is not None:
        collection_ctx = _load_collection_context(conn, collection_version_id, user_id)
        config = collection_ctx["config"]
        if "family" not in config.get("modules", []):
            raise HTTPException(status_code=400, detail="Sklop ni del izbrane zbirke.")
        family_cfg = config.get("family", {})
        levels = list(family_cfg.get("levels", ["A1", "A2"]))
        modes = list(family_cfg.get("modes", ["noun", "phrase"]))
        cases = list(family_cfg.get("cases", ["nominative"]))
        include_plural = bool(family_cfg.get("include_plural", True))
    else:
        levels = levels or ["A1", "A2"]
        modes = modes or ["noun", "phrase"]
        cases = cases or ["nominative"]
        if "A2" not in levels:
            cases = ["nominative"]
        if "phrase" in modes and not cases:
            raise HTTPException(status_code=400, detail="Izberi vsaj en sklon.")
    results = learn.fetch_family_results(
        conn,
        user_id,
        levels,
        modes,
        cases,
        include_plural=include_plural,
        collection_version_id=collection_version_id,
    )
    items: List[ItemOut] = []
    for row in results:
        items.append(
            ItemOut(
                id=row["id"],
                type="family",
                translation=row["translation"],
                metadata={},
                labels=row["labels"],
                solution=row["solutions"] if include_solution else None,
                attempts=row["attempts"],
                correct=row["correct"],
                wrong=row["wrong"],
                reveals=row["reveals"],
                streak=row["streak"],
            )
        )
    return items


@app.get("/items/{item_id}", response_model=ItemOut)
def item_detail(
    item_id: int,
    include_solution: bool = Query(default=False),
    conn: sqlite3.Connection = Depends(get_db),
) -> ItemOut:
    row = conn.execute(
        "SELECT id, type, translation, solution_json, metadata_json FROM items WHERE id = ?",
        (item_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
    return serialize_item_row(row, include_solution=include_solution)


@app.get("/users/{user_id}/stats", response_model=StatsOut)
def user_stats(
    user_id: int,
    word_type: WordType = Query(...),
    collection_version_id: Optional[int] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> StatsOut:
    ensure_user(conn, user_id)
    collection_config: Optional[Dict[str, object]] = None
    if collection_version_id is not None:
        collection_ctx = _load_collection_context(conn, collection_version_id, user_id)
        collection_config = collection_ctx["config"]
        if word_type not in collection_config.get("modules", []):
            raise HTTPException(status_code=400, detail="Sklop ni del izbrane zbirke.")
    if word_type == "number":
        if collection_version_id is None:
            stats_row = conn.execute(
                """
                SELECT
                    COALESCE(SUM(attempts), 0) AS attempts,
                    COALESCE(SUM(correct), 0) AS correct,
                    COALESCE(SUM(wrong), 0) AS wrong,
                    COALESCE(SUM(reveals), 0) AS reveals
                FROM number_stats
                WHERE user_id = ?
                """,
                (user_id,),
            ).fetchone()
        else:
            stats_row = conn.execute(
                """
                SELECT
                    COALESCE(SUM(attempts), 0) AS attempts,
                    COALESCE(SUM(correct), 0) AS correct,
                    COALESCE(SUM(wrong), 0) AS wrong,
                    COALESCE(SUM(reveals), 0) AS reveals
                FROM collection_number_stats
                WHERE user_id = ? AND collection_version_id = ?
                """,
                (user_id, collection_version_id),
            ).fetchone()
        attempts = stats_row["attempts"] or 0
        correct = stats_row["correct"] or 0
        wrong = stats_row["wrong"] or 0
        reveals = stats_row["reveals"] or 0
        accuracy = (correct / attempts) if attempts else 0.0
        cycle_count = learn.fetch_number_cycle_count(conn, user_id, collection_version_id)
        return StatsOut(
            user_id=user_id,
            word_type=word_type,
            attempts=attempts,
            correct=correct,
            wrong=wrong,
            reveals=reveals,
            accuracy=accuracy,
            cycle_count=cycle_count,
        )
    if word_type == "family":
        if collection_version_id is None:
            stats_row = conn.execute(
                """
                SELECT
                    COALESCE(SUM(attempts), 0) AS attempts,
                    COALESCE(SUM(correct), 0) AS correct,
                    COALESCE(SUM(wrong), 0) AS wrong,
                    COALESCE(SUM(reveals), 0) AS reveals
                FROM family_stats
                WHERE user_id = ?
                """,
                (user_id,),
            ).fetchone()
        else:
            stats_row = conn.execute(
                """
                SELECT
                    COALESCE(SUM(attempts), 0) AS attempts,
                    COALESCE(SUM(correct), 0) AS correct,
                    COALESCE(SUM(wrong), 0) AS wrong,
                    COALESCE(SUM(reveals), 0) AS reveals
                FROM collection_family_stats
                WHERE user_id = ? AND collection_version_id = ?
                """,
                (user_id, collection_version_id),
            ).fetchone()
        attempts = stats_row["attempts"] or 0
        correct = stats_row["correct"] or 0
        wrong = stats_row["wrong"] or 0
        reveals = stats_row["reveals"] or 0
        accuracy = (correct / attempts) if attempts else 0.0
        cycle_count = learn.fetch_family_cycle_count(conn, user_id, collection_version_id)
        return StatsOut(
            user_id=user_id,
            word_type=word_type,
            attempts=attempts,
            correct=correct,
            wrong=wrong,
            reveals=reveals,
            accuracy=accuracy,
            cycle_count=cycle_count,
        )
    restrict_items = False
    if collection_version_id is not None:
        scope = collection_config.get(word_type, {}).get("scope", "all") if collection_config else "all"
        restrict_items = scope == "subset"
        stats_row = conn.execute(
            f"""
            SELECT
                COALESCE(SUM(us.attempts), 0) AS attempts,
                COALESCE(SUM(us.correct), 0) AS correct,
                COALESCE(SUM(us.wrong), 0) AS wrong,
                COALESCE(SUM(us.reveals), 0) AS reveals
            FROM collection_user_stats us
            JOIN items ON items.id = us.entry_id
            {"" if not restrict_items else "JOIN collection_version_items cvi ON cvi.item_id = items.id AND cvi.collection_version_id = ?"}
            WHERE us.user_id = ? AND us.collection_version_id = ? AND items.type = ?
            """,
            tuple(
                ([] if not restrict_items else [collection_version_id])
                + [user_id, collection_version_id, word_type]
            ),
        ).fetchone()
    else:
        stats_row = conn.execute(
            """
            SELECT
                COALESCE(SUM(us.attempts), 0) AS attempts,
                COALESCE(SUM(us.correct), 0) AS correct,
                COALESCE(SUM(us.wrong), 0) AS wrong,
                COALESCE(SUM(us.reveals), 0) AS reveals
            FROM user_stats us
            JOIN items ON items.id = us.entry_id
            WHERE us.user_id = ? AND items.type = ?
            """,
            (user_id, word_type),
        ).fetchone()
    attempts = stats_row["attempts"] or 0
    correct = stats_row["correct"] or 0
    wrong = stats_row["wrong"] or 0
    reveals = stats_row["reveals"] or 0
    accuracy = (correct / attempts) if attempts else 0.0
    cycle_count = learn.fetch_cycle_count(conn, user_id, word_type, collection_version_id)
    return StatsOut(
        user_id=user_id,
        word_type=word_type,
        attempts=attempts,
        correct=correct,
        wrong=wrong,
        reveals=reveals,
        accuracy=accuracy,
        cycle_count=cycle_count,
    )


@app.post("/import/{word_type}", response_model=ImportResult)
async def import_csv_endpoint(
    word_type: WordType,
    user_id: int = Query(...),
    file: UploadFile = File(...),
    conn: sqlite3.Connection = Depends(get_db),
) -> ImportResult:
    if word_type == "number":
        raise HTTPException(status_code=400, detail="Uvoz CSV ni podprt za števila.")
    if word_type == "family":
        raise HTTPException(status_code=400, detail="Uvoz CSV ni podprt za družino.")
    if file.content_type not in {"text/csv", "application/vnd.ms-excel", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Pričakovana je CSV datoteka.")
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    ensure_user(conn, user_id)
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="Izberi prijavljenega uporabnika.")
    ensure_author(conn, user_id)
    rows = learn.parse_csv_content(text)
    if word_type == "noun":
        records, errors = learn.build_noun_records(rows)
    else:
        records, errors = learn.build_verb_records(rows)
    added = 0
    skipped = 0
    for keyword, translation, solution_json, metadata_json in records:
        exists = conn.execute(
            "SELECT 1 FROM items WHERE type = ? AND keyword = ?",
            (word_type, keyword),
        ).fetchone()
        if exists:
            skipped += 1
            continue
        pending = conn.execute(
            """
            SELECT 1 FROM item_proposals
            WHERE status = 'pending' AND word_type = ? AND keyword = ?
            """,
            (word_type, keyword),
        ).fetchone()
        if pending:
            skipped += 1
            continue
        _create_item_proposal(
            conn,
            proposer_user_id=user_id,
            proposal_type="create",
            word_type=word_type,
            item_id=None,
            keyword=keyword,
            translation=translation,
            solution_json=solution_json,
            metadata_json=metadata_json,
        )
        added += 1
    return ImportResult(added=added, skipped=skipped, errors=errors)


@app.get("/item-proposals", response_model=List[ItemProposalOut])
def list_item_proposals(
    reviewer_user_id: int = Query(...),
    status: ProposalStatus = Query("pending"),
    word_type: Optional[WordType] = Query(default=None),
    proposal_type: Optional[str] = Query(default=None),
    proposer_user_id: Optional[int] = Query(default=None),
    query: Optional[str] = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> List[ItemProposalOut]:
    ensure_moderator(conn, reviewer_user_id)
    params: List[object] = [status]
    sql_query = """
        SELECT
            p.*,
            u.name AS proposer_name,
            r.name AS reviewer_name
        FROM item_proposals p
        JOIN users u ON u.id = p.proposer_user_id
        LEFT JOIN users r ON r.id = p.reviewer_user_id
        WHERE p.status = ?
    """
    if word_type:
        if word_type not in ("noun", "verb"):
            raise HTTPException(status_code=400, detail="Neveljaven sklop.")
        sql_query += " AND p.word_type = ?"
        params.append(word_type)
    if proposal_type:
        if proposal_type not in ("create", "update", "delete"):
            raise HTTPException(status_code=400, detail="Neveljaven tip predloga.")
        sql_query += " AND p.proposal_type = ?"
        params.append(proposal_type)
    if proposer_user_id:
        sql_query += " AND p.proposer_user_id = ?"
        params.append(proposer_user_id)
    search_text = (query or "").strip().lower()
    if search_text:
        sql_query += " AND (LOWER(p.keyword) LIKE ? OR LOWER(p.translation) LIKE ? OR LOWER(p.solution_json) LIKE ?)"
        like = f"%{search_text}%"
        params.extend([like, like, like])
    sql_query += " ORDER BY p.proposed_at DESC"
    rows = conn.execute(sql_query, tuple(params)).fetchall()
    return [serialize_proposal_row(row) for row in rows]


@app.post("/item-proposals/{proposal_id}/review", response_model=ItemProposalOut)
def review_item_proposal(
    proposal_id: int,
    payload: ItemProposalReview,
    conn: sqlite3.Connection = Depends(get_db),
) -> ItemProposalOut:
    ensure_moderator(conn, payload.reviewer_user_id)
    row = _fetch_item_proposal(conn, proposal_id)
    if row["status"] != "pending":
        raise HTTPException(status_code=400, detail="Predlog je že obdelan.")
    review_notes = payload.review_notes.strip() if payload.review_notes else None
    now = learn.now_iso()

    if payload.status == "approved":
        keyword = row["keyword"]
        if row["proposal_type"] in ("create", "update"):
            existing = conn.execute(
                "SELECT id FROM items WHERE type = ? AND keyword = ?",
                (row["word_type"], keyword),
            ).fetchone()
            if existing and (row["proposal_type"] == "create" or existing["id"] != row["item_id"]):
                payload = ItemProposalReview(
                    reviewer_user_id=payload.reviewer_user_id,
                    status="rejected",
                    review_notes="Vnos z enakim ključem že obstaja.",
                )
                review_notes = payload.review_notes
        if row["proposal_type"] == "create" and payload.status == "approved":
            conn.execute(
                """
                INSERT INTO items (type, keyword, translation, solution_json, metadata_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    row["word_type"],
                    row["keyword"],
                    row["translation"],
                    row["solution_json"],
                    row["metadata_json"],
                ),
            )
        elif row["proposal_type"] == "update" and payload.status == "approved":
            current = conn.execute(
                "SELECT id FROM items WHERE id = ?",
                (row["item_id"],),
            ).fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
            conn.execute(
                """
                UPDATE items
                SET keyword = ?, translation = ?, solution_json = ?, metadata_json = ?
                WHERE id = ?
                """,
                (
                    row["keyword"],
                    row["translation"],
                    row["solution_json"],
                    row["metadata_json"],
                    row["item_id"],
                ),
            )
        elif row["proposal_type"] == "delete" and payload.status == "approved":
            current = conn.execute(
                "SELECT id FROM items WHERE id = ?",
                (row["item_id"],),
            ).fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
            conn.execute("DELETE FROM items WHERE id = ?", (row["item_id"],))

    conn.execute(
        """
        UPDATE item_proposals
        SET status = ?, reviewed_at = ?, reviewer_user_id = ?, review_notes = ?
        WHERE id = ?
        """,
        (
            payload.status,
            now,
            payload.reviewer_user_id,
            review_notes,
            proposal_id,
        ),
    )
    conn.commit()
    row = _fetch_item_proposal(conn, proposal_id)
    return serialize_proposal_row(row)


@app.put("/items/{item_id}", response_model=ItemProposalOut)
def update_item(
    item_id: int,
    payload: ItemUpdate,
    conn: sqlite3.Connection = Depends(get_db),
) -> ItemProposalOut:
    ensure_user(conn, payload.user_id)
    if payload.user_id <= 0:
        raise HTTPException(status_code=400, detail="Izberi prijavljenega uporabnika.")
    ensure_author(conn, payload.user_id)
    row = conn.execute(
        "SELECT id, type FROM items WHERE id = ?",
        (item_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
    word_type = row["type"]
    translation = payload.translation.strip()
    if not translation:
        raise HTTPException(status_code=400, detail="Prevod ne sme biti prazen.")
    solutions = [value.strip() for value in payload.solution]
    keyword, new_translation, solution_json, metadata_json = _build_item_record(
        word_type,
        translation,
        solutions,
    )
    pending = conn.execute(
        """
        SELECT 1 FROM item_proposals
        WHERE status = 'pending' AND word_type = ? AND item_id = ?
        """,
        (word_type, item_id),
    ).fetchone()
    if pending:
        raise HTTPException(status_code=400, detail="Za ta vnos že obstaja odprt predlog.")
    return _create_item_proposal(
        conn,
        proposer_user_id=payload.user_id,
        proposal_type="update",
        word_type=word_type,
        item_id=item_id,
        keyword=keyword,
        translation=new_translation,
        solution_json=solution_json,
        metadata_json=metadata_json,
    )


@app.delete("/items/{item_id}", response_model=ItemProposalOut, status_code=202)
def delete_item(
    item_id: int,
    user_id: int = Query(...),
    conn: sqlite3.Connection = Depends(get_db),
) -> ItemProposalOut:
    ensure_user(conn, user_id)
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="Izberi prijavljenega uporabnika.")
    ensure_author(conn, user_id)
    row = conn.execute(
        "SELECT id, type, keyword, translation, solution_json, metadata_json FROM items WHERE id = ?",
        (item_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
    pending = conn.execute(
        """
        SELECT 1 FROM item_proposals
        WHERE status = 'pending' AND word_type = ? AND item_id = ?
        """,
        (row["type"], item_id),
    ).fetchone()
    if pending:
        raise HTTPException(status_code=400, detail="Za ta vnos že obstaja odprt predlog.")
    return _create_item_proposal(
        conn,
        proposer_user_id=user_id,
        proposal_type="delete",
        word_type=row["type"],
        item_id=item_id,
        keyword=row["keyword"],
        translation=row["translation"],
        solution_json=row["solution_json"],
        metadata_json=row["metadata_json"],
    )


@app.post("/items", response_model=ItemProposalOut, status_code=202)
def create_item(payload: ItemCreate, conn: sqlite3.Connection = Depends(get_db)) -> ItemProposalOut:
    if payload.type == "number":
        raise HTTPException(status_code=400, detail="Števil ni mogoče dodajati ročno.")
    if payload.type == "family":
        raise HTTPException(status_code=400, detail="Družine ni mogoče dodajati ročno.")
    ensure_user(conn, payload.user_id)
    if payload.user_id <= 0:
        raise HTTPException(status_code=400, detail="Izberi prijavljenega uporabnika.")
    ensure_author(conn, payload.user_id)
    translation = payload.translation.strip()
    if not translation:
        raise HTTPException(status_code=400, detail="Prevod ne sme biti prazen.")
    solutions = [value.strip() for value in payload.solution]
    keyword, new_translation, solution_json, metadata_json = _build_item_record(
        payload.type,
        translation,
        solutions,
    )
    exists = conn.execute(
        "SELECT 1 FROM items WHERE type = ? AND keyword = ?",
        (payload.type, keyword),
    ).fetchone()
    if exists:
        raise HTTPException(status_code=400, detail="Vnos z enakim ključem že obstaja.")
    pending = conn.execute(
        """
        SELECT 1 FROM item_proposals
        WHERE status = 'pending' AND word_type = ? AND keyword = ?
        """,
        (payload.type, keyword),
    ).fetchone()
    if pending:
        raise HTTPException(status_code=400, detail="Za ta vnos že obstaja odprt predlog.")
    return _create_item_proposal(
        conn,
        proposer_user_id=payload.user_id,
        proposal_type="create",
        word_type=payload.type,
        item_id=None,
        keyword=keyword,
        translation=new_translation,
        solution_json=solution_json,
        metadata_json=metadata_json,
    )

@app.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    ensure_user(conn, user_id)
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    return Response(status_code=204)

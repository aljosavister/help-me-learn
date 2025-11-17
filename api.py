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

WordType = Literal["noun", "verb"]

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


def _init_database() -> None:
    conn = _connect_db()
    conn.row_factory = sqlite3.Row
    learn.ensure_schema(conn)
    learn.seed_items(conn)
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
    row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Uporabnik ne obstaja.")


class UserCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class UserOut(BaseModel):
    id: int
    name: str
    created_at: str


class ModuleOut(BaseModel):
    type: WordType
    label: str
    description: str


class CycleRequest(BaseModel):
    user_id: int
    word_type: WordType
    include_solutions: bool = False


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


class AttemptRequest(BaseModel):
    user_id: int
    item_id: int
    word_type: WordType
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


class DeleteUserRequest(BaseModel):
    user_id: int


@app.get("/")
def root() -> Dict[str, str]:
    return {"message": "German Trainer API je pripravljen.", "db": str(learn.DB_PATH)}


@app.get("/users", response_model=List[UserOut])
def list_users(conn: sqlite3.Connection = Depends(get_db)) -> List[UserOut]:
    rows = conn.execute("SELECT id, name, created_at FROM users ORDER BY id").fetchall()
    return [UserOut(id=row["id"], name=row["name"], created_at=row["created_at"]) for row in rows]


@app.post("/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, conn: sqlite3.Connection = Depends(get_db)) -> UserOut:
    user_id = learn.get_or_create_user(conn, payload.name.strip())
    row = conn.execute("SELECT id, name, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
    return UserOut(id=row["id"], name=row["name"], created_at=row["created_at"])


@app.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, conn: sqlite3.Connection = Depends(get_db)) -> UserOut:
    row = conn.execute("SELECT id, name, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Uporabnik ne obstaja.")
    return UserOut(id=row["id"], name=row["name"], created_at=row["created_at"])


@app.get("/modules", response_model=List[ModuleOut])
def list_modules() -> List[ModuleOut]:
    return [
        ModuleOut(type="noun", label="Samostalniki", description="Člen in samostalnik v eni vrstici."),
        ModuleOut(type="verb", label="Nepravilni glagoli", description="4 oblike: infinitiv, 3. oseba, preterit, perfekt."),
    ]


@app.post("/cycles", response_model=CycleResponse)
def start_cycle(payload: CycleRequest, conn: sqlite3.Connection = Depends(get_db)) -> CycleResponse:
    ensure_user(conn, payload.user_id)
    cycle_index = learn.fetch_cycle_count(conn, payload.user_id, payload.word_type) + 1
    total_attempts, accuracy = learn.global_accuracy(conn, payload.user_id, payload.word_type)
    adaptive = (
        cycle_index > learn.ADAPTIVE_AFTER_CYCLES
        or (total_attempts >= learn.MIN_ATTEMPTS_FOR_ADAPTIVE and accuracy >= learn.HIGH_ACCURACY_THRESHOLD)
    )

    items = learn.fetch_items_with_stats(conn, payload.user_id, payload.word_type)
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
    learn.increment_cycle(conn, payload.user_id, payload.word_type)
    return {"status": "ok"}


@app.post("/attempts", response_model=AttemptResponse)
def submit_attempt(payload: AttemptRequest, conn: sqlite3.Connection = Depends(get_db)) -> AttemptResponse:
    ensure_user(conn, payload.user_id)
    row = conn.execute(
        "SELECT id, type, solution_json FROM items WHERE id = ?", (payload.item_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Vnos ne obstaja.")
    if row["type"] != payload.word_type:
        raise HTTPException(status_code=400, detail="Vrsta besede se ne ujema z vnosom.")

    solutions = json.loads(row["solution_json"])
    correct = learn.check_answers(payload.answers, solutions)
    effective_correct = bool(correct and not payload.revealed)
    cycle_number = payload.cycle_number or (
        learn.fetch_cycle_count(conn, payload.user_id, payload.word_type) + 1
    )
    learn.update_progress(
        conn=conn,
        user_id=payload.user_id,
        item_id=payload.item_id,
        correct=effective_correct,
        revealed=payload.revealed,
        answers=payload.answers,
        cycle_number=cycle_number,
    )
    solution_payload = solutions if (payload.show_solution or payload.revealed) else None
    return AttemptResponse(correct=effective_correct, revealed=payload.revealed, solution=solution_payload)


@app.get("/items", response_model=List[ItemOut])
def browse_items(
    word_type: Optional[WordType] = Query(default=None),
    include_solution: bool = Query(default=False),
    conn: sqlite3.Connection = Depends(get_db),
) -> List[ItemOut]:
    query = "SELECT id, type, translation, solution_json, metadata_json FROM items"
    params: List = []
    if word_type:
        query += " WHERE type = ?"
        params.append(word_type)
    query += " ORDER BY id"
    rows = conn.execute(query, tuple(params)).fetchall()
    items: List[ItemOut] = []
    for row in rows:
        metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
        labels = learn.get_labels(row["type"], metadata)
        solutions = json.loads(row["solution_json"]) if include_solution else None
        items.append(
            ItemOut(
                id=row["id"],
                type=row["type"],
                translation=row["translation"],
                metadata=metadata,
                labels=labels,
                solution=solutions,
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
    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
    labels = learn.get_labels(row["type"], metadata)
    solution = json.loads(row["solution_json"]) if include_solution else None
    return ItemOut(
        id=row["id"],
        type=row["type"],
        translation=row["translation"],
        metadata=metadata,
        labels=labels,
        solution=solution,
    )


@app.get("/users/{user_id}/stats", response_model=StatsOut)
def user_stats(
    user_id: int,
    word_type: WordType = Query(...),
    conn: sqlite3.Connection = Depends(get_db),
) -> StatsOut:
    ensure_user(conn, user_id)
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
    cycle_count = learn.fetch_cycle_count(conn, user_id, word_type)
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
    file: UploadFile = File(...),
    conn: sqlite3.Connection = Depends(get_db),
) -> ImportResult:
    if file.content_type not in {"text/csv", "application/vnd.ms-excel", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Pričakovana je CSV datoteka.")
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    result = learn.import_csv_text(conn, word_type, text)
    return ImportResult(added=result["added"], skipped=result["skipped"], errors=result["errors"])
@app.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    ensure_user(conn, user_id)
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    return Response(status_code=204)

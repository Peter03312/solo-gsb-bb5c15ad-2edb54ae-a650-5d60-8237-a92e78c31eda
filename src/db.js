'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'subsync.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_chars INTEGER NOT NULL,
  min_display_ms INTEGER NOT NULL,
  max_cps REAL NOT NULL,
  settings_version INTEGER NOT NULL DEFAULT 1,
  transcript_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS words (
  seq INTEGER PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cuts (
  at_ms INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS cues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  word_start_seq INTEGER,
  word_end_seq INTEGER,
  locked INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_version INTEGER NOT NULL,
  cue_count INTEGER NOT NULL,
  vtt TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();

function getProject() {
  return db.prepare('SELECT * FROM project WHERE id = 1').get();
}

function initProjectIfNeeded() {
  if (!getProject()) {
    db.prepare(
      `INSERT INTO project (id, max_chars, min_display_ms, max_cps, settings_version, transcript_version, updated_at)
       VALUES (1, 18, 800, 12, 1, 0, ?)`
    ).run(now());
  }
}

module.exports = { db, getProject, initProjectIfNeeded, now, DATA_DIR };

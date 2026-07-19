import { DatabaseSync, StatementSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

const DB_PATH =
  process.env.DATABASE_URL ||
  path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'wetrade.db');

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    const resolved = path.resolve(DB_PATH);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    db = new DatabaseSync(resolved);
    initSchema(db);
    logger.info('Database ready', { path: resolved });
  }
  return db;
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS processed_posts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id           TEXT    UNIQUE NOT NULL,
      post_url          TEXT    NOT NULL,
      original_text     TEXT    NOT NULL,
      generated_message TEXT,
      media_url         TEXT,
      sent_to_whatsapp  INTEGER NOT NULL DEFAULT 0,
      chat_sent         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_processed_posts_post_id
      ON processed_posts(post_id);
  `);

  for (const [col, def] of [
    ['media_url', 'TEXT'],
    ['chat_sent', 'INTEGER NOT NULL DEFAULT 0'],
  ] as [string, string][]) {
    try { database.exec(`ALTER TABLE processed_posts ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  }
}

export interface ProcessedPost {
  id?: number;
  post_id: string;
  post_url: string;
  original_text: string;
  generated_message?: string | null;
  media_url?: string | null;
  sent_to_whatsapp?: boolean;
  chat_sent?: boolean;
  created_at?: string;
}

export function isPostProcessed(postId: string): boolean {
  const row = getDb()
    .prepare('SELECT id FROM processed_posts WHERE post_id = ?')
    .get(postId);
  return !!row;
}

export function savePost(post: ProcessedPost): void {
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO processed_posts
        (post_id, post_url, original_text, generated_message, media_url, sent_to_whatsapp)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      post.post_id,
      post.post_url,
      post.original_text,
      post.generated_message ?? null,
      post.media_url ?? null,
      post.sent_to_whatsapp ? 1 : 0,
    );
}

export function getPost(postId: string): ProcessedPost | null {
  const row = getDb()
    .prepare('SELECT * FROM processed_posts WHERE post_id = ?')
    .get(postId);
  return (row as ProcessedPost | undefined) ?? null;
}

export function markChatSent(postId: string): boolean {
  const result = getDb()
    .prepare('UPDATE processed_posts SET chat_sent = 1 WHERE post_id = ? AND chat_sent = 0')
    .run(postId) as unknown as { changes: number };
  return result.changes > 0;
}

export function updatePostStatus(
  postId: string,
  generatedMessage: string,
  sent: boolean,
): void {
  getDb()
    .prepare(`
      UPDATE processed_posts
      SET generated_message = ?, sent_to_whatsapp = ?
      WHERE post_id = ?
    `)
    .run(generatedMessage, sent ? 1 : 0, postId);
}

export function getRecentPosts(limit = 20): ProcessedPost[] {
  return getDb()
    .prepare(`
      SELECT * FROM processed_posts
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as unknown as ProcessedPost[];
}

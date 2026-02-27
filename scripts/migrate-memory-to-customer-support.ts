/**
 * One-shot migration: copy customersupportbot memory data from main.sqlite
 * into customer-support.sqlite (files, chunks, embedding_cache).
 *
 * Safe to re-run — skips rows that already exist (matched by path/hash/id).
 * Does NOT touch chunks_vec; openclaw rebuilds that on next startup when it
 * detects chunks without a matching vec row.
 */
import { DatabaseSync } from "node:sqlite";

const MAIN_DB = "/root/.openclaw/memory/main.sqlite";
const CS_DB = "/root/.openclaw/memory/customer-support.sqlite";
const PATH_FILTER = "%customersupportbot%";

const main = new DatabaseSync(MAIN_DB, { open: true, readOnly: true });
const cs = new DatabaseSync(CS_DB, { open: true });

// --- files ---
const existingFiles = new Set(
  cs.prepare("SELECT path FROM files").all().map((r: any) => r.path),
);

const mainFiles = main
  .prepare("SELECT path, source, hash, mtime, size FROM files WHERE path LIKE ?")
  .all(PATH_FILTER) as any[];

const insertFile = cs.prepare(
  "INSERT OR IGNORE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
);

let filesAdded = 0;
for (const f of mainFiles) {
  if (existingFiles.has(f.path)) continue;
  insertFile.run(f.path, f.source, f.hash, f.mtime, f.size);
  filesAdded++;
  console.log(`  + file: ${f.path}`);
}
console.log(`Files: ${filesAdded} added, ${existingFiles.size} already existed\n`);

// --- chunks ---
const existingChunks = new Set(
  cs.prepare("SELECT id FROM chunks").all().map((r: any) => r.id),
);

const mainChunks = main
  .prepare(
    "SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at FROM chunks WHERE path LIKE ?",
  )
  .all(PATH_FILTER) as any[];

const insertChunk = cs.prepare(
  "INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

let chunksAdded = 0;
for (const c of mainChunks) {
  if (existingChunks.has(c.id)) continue;
  insertChunk.run(c.id, c.path, c.source, c.start_line, c.end_line, c.hash, c.model, c.text, c.embedding, c.updated_at);
  chunksAdded++;
}
console.log(`Chunks: ${chunksAdded} added, ${existingChunks.size} already existed\n`);

// --- embedding_cache ---
const existingEmbeddings = new Set(
  cs.prepare("SELECT hash FROM embedding_cache").all().map((r: any) => r.hash),
);

const mainEmbeddings = main
  .prepare(
    "SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM embedding_cache",
  )
  .all() as any[];

const insertEmb = cs.prepare(
  "INSERT OR IGNORE INTO embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

let embAdded = 0;
for (const e of mainEmbeddings) {
  if (existingEmbeddings.has(e.hash)) continue;
  insertEmb.run(e.provider, e.model, e.provider_key, e.hash, e.embedding, e.dims, e.updated_at);
  embAdded++;
}
console.log(`Embedding cache: ${embAdded} added, ${existingEmbeddings.size} already existed\n`);

// --- FTS rebuild ---
console.log("Rebuilding FTS index...");
cs.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

// --- summary ---
const totalFiles = cs.prepare("SELECT count(*) as c FROM files").get() as any;
const totalChunks = cs.prepare("SELECT count(*) as c FROM chunks").get() as any;
const totalEmb = cs.prepare("SELECT count(*) as c FROM embedding_cache").get() as any;
const withVec = cs.prepare("SELECT count(*) as c FROM chunks WHERE embedding IS NOT NULL").get() as any;

console.log("\n=== customer-support.sqlite post-migration ===");
console.log(`Files: ${totalFiles.c}`);
console.log(`Chunks: ${totalChunks.c} (${withVec.c} with embeddings)`);
console.log(`Embedding cache: ${totalEmb.c}`);
console.log("\nDone. Restart the container so openclaw rebuilds chunks_vec from the new embeddings.");

main.close();
cs.close();

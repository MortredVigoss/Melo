// Project memory book (design 2026-10-17 §3.4, 2B). Implementation lives in
// src/memory/projectBook.js (memory layer) so that factRecords.js can write
// auto rows without a memory → services dependency; this path is kept for
// the service/HTTP/UI callers.
export * from '../../memory/projectBook.js';

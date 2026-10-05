-- Synthetic Antigravity conversations database (`conversations/<uuid>.db`), hand-written from
-- 15 §5 (Antigravity row, AMENDMENT-13) for the AntigravityObservationAdapter conformance suite
-- (ISSUE-074). `gen_metadata(idx, data)` holds one row per generation; each blob is plaintext
-- protobuf with the model id at field 1.19 and usage at 1.17.2 (1 uncached input, 2 cache write,
-- 5 cache read, 9 reasoning, 10 output). The blobs also carry fields the reader ignores (a string at
-- 1.3, varints at 2, 5 and 1.17.4, a fixed64 at 1.30). Blobs are hex, one byte per pair, read with
-- `unhex(..., ' ')`. Replace with a scrubbed recording of a real database (ISSUE-319).

CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL);

-- idx 1: synthetic-model-a, input 1200, cache write 0, cache read 3400, reasoning 50, output 210.
INSERT INTO gen_metadata (idx, data) VALUES (1, unhex('10 01 0a 48 1a 14 73 79 6e 74 68 65 74 69 63 2d 74 72 61 6a 65 63 74 6f 72 79 9a 01 11 73 79 6e 74 68 65 74 69 63 2d 6d 6f 64 65 6c 2d 61 8a 01 11 20 01 12 0d 08 b0 09 10 00 28 c8 1a 48 32 50 d2 01 f1 01 00 00 00 00 00 00 f0 3f 28 07', ' '));
-- idx 2: synthetic-model-a, input 300, cache read 4600, output 95.
INSERT INTO gen_metadata (idx, data) VALUES (2, unhex('10 01 0a 43 1a 14 73 79 6e 74 68 65 74 69 63 2d 74 72 61 6a 65 63 74 6f 72 79 9a 01 11 73 79 6e 74 68 65 74 69 63 2d 6d 6f 64 65 6c 2d 61 8a 01 0c 20 01 12 08 08 ac 02 28 f8 23 50 5f f1 01 00 00 00 00 00 00 f0 3f 28 07', ' '));
-- idx 3: synthetic-model-b, input 80, cache write 512, cache read 5000, reasoning 20, output 44.
INSERT INTO gen_metadata (idx, data) VALUES (3, unhex('10 01 0a 47 1a 14 73 79 6e 74 68 65 74 69 63 2d 74 72 61 6a 65 63 74 6f 72 79 9a 01 11 73 79 6e 74 68 65 74 69 63 2d 6d 6f 64 65 6c 2d 62 8a 01 10 20 01 12 0c 08 50 10 80 04 28 88 27 48 14 50 2c f1 01 00 00 00 00 00 00 f0 3f 28 07', ' '));

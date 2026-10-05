-- Synthetic Antigravity conversations database with drifted blobs (FM-068; 15 §5 Antigravity row,
-- AMENDMENT-13), for the AntigravityObservationAdapter conformance suite (ISSUE-074): idx 2 is cut
-- short (it does not decode), idx 3 decodes but its usage moved from 1.17 to 1.18 (the path the
-- reader is pinned to is absent). Both yield no usage and count as drift; idx 1 and idx 4 read as
-- in `conversation-db.sql`. Replace with a scrubbed recording (ISSUE-319).

CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL);

INSERT INTO gen_metadata (idx, data) VALUES (1, unhex('10 01 0a 48 1a 14 73 79 6e 74 68 65 74 69 63 2d 74 72 61 6a 65 63 74 6f 72 79 9a 01 11 73 79 6e 74 68 65 74 69 63 2d 6d 6f 64 65 6c 2d 61 8a 01 11 20 01 12 0d 08 b0 09 10 00 28 c8 1a 48 32 50 d2 01 f1 01 00 00 00 00 00 00 f0 3f 28 07', ' '));
-- idx 2: the first 20 bytes of a generation; the length at 1 runs past the end.
INSERT INTO gen_metadata (idx, data) VALUES (2, unhex('10 01 0a 43 1a 14 73 79 6e 74 68 65 74 69 63 2d 74 72 61 6a', ' '));
-- idx 3: the model id at 1.19, the usage message at 1.18.2 instead of 1.17.2.
INSERT INTO gen_metadata (idx, data) VALUES (3, unhex('10 01 0a 1b 9a 01 11 73 79 6e 74 68 65 74 69 63 2d 6d 6f 64 65 6c 2d 61 92 01 04 12 02 08 0a', ' '));
INSERT INTO gen_metadata (idx, data) VALUES (4, unhex('10 01 0a 47 1a 14 73 79 6e 74 68 65 74 69 63 2d 74 72 61 6a 65 63 74 6f 72 79 9a 01 11 73 79 6e 74 68 65 74 69 63 2d 6d 6f 64 65 6c 2d 62 8a 01 10 20 01 12 0c 08 50 10 80 04 28 88 27 48 14 50 2c f1 01 00 00 00 00 00 00 f0 3f 28 07', ' '));

-- Synthetic Antigravity conversations database without a `gen_metadata` table (FM-068; 15 §5
-- Antigravity row, AMENDMENT-13), for the AntigravityObservationAdapter conformance suite
-- (ISSUE-074): a later Antigravity that renamed or dropped the table. It yields no usage and counts
-- as drift once; the transcript side goes on. Replace with a scrubbed recording (ISSUE-319).

CREATE TABLE generations (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);

INSERT INTO generations (id, payload) VALUES (1, unhex('10 01', ' '));

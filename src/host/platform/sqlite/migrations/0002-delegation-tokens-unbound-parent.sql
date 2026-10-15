-- Migration 0002-delegation-tokens-unbound-parent: owner amendment N (AMENDMENT-14, OQ-85),
-- 2026-10-15, entries A14-05 and A14-06 (09 §4.6 target DDL).
--   - `parent_dwarf_id` becomes nullable: the token row is written before the driver starts, and
--     the launch's dwarf row exists only after the handshake (`DwarfLaunched`), when
--     `DelegationLifecycle.bindParent` fills it in.
--   - the hash CHECK covers `protocol` too: every relay entry (`ticket-file`, `protocol`)
--     authenticates with the credential file (ADR-013 item 3; 16 §5.2).
-- SQLite cannot ALTER a CHECK or a NOT NULL, so this is the 09 §6.3 table rebuild. The runner
-- runs it with `foreign_keys = OFF` outside its one transaction and checks `PRAGMA
-- foreign_key_check` before COMMIT (09 §6.2 step 7). No table references `delegation_tokens`.
-- Never rewritten once an internal build has applied it (21 §5.1).

CREATE TABLE delegation_tokens_new (
  launch_id          TEXT    NOT NULL PRIMARY KEY REFERENCES launches (id) ON DELETE CASCADE,
  -- the launch's dwarf, NULL until DwarfLaunched (the dwarf row needs a provider session id, which exists only after the handshake)
  parent_dwarf_id    TEXT    REFERENCES dwarfs (id) ON DELETE CASCADE,
  mechanism          TEXT    NOT NULL CHECK (mechanism IN ('in-process', 'protocol', 'ticket-file')),
  credential_hash    TEXT    CHECK (credential_hash IS NULL OR length(credential_hash) = 64),
  issued_at          INTEGER NOT NULL,
  revoked_at         INTEGER,
  -- every relay entry (ticket-file, protocol) authenticates with the credential file (ADR-013 item 3; 16 §5.2)
  CHECK ((mechanism IN ('ticket-file', 'protocol')) = (credential_hash IS NOT NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO delegation_tokens_new (launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at, revoked_at)
  SELECT launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at, revoked_at FROM delegation_tokens;
DROP TABLE delegation_tokens;
ALTER TABLE delegation_tokens_new RENAME TO delegation_tokens;
CREATE INDEX delegation_tokens_parent ON delegation_tokens (parent_dwarf_id);

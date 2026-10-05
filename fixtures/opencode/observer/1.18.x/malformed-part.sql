-- Rows this build cannot read: a part whose data is not JSON, a text part without text, a part
-- whose data is a JSON array, and a message whose data is not JSON (its parts cannot be
-- attributed to a role). Each is skipped with one warning; the rows around them still read.
-- Synthetic (meta.json).
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
VALUES ('ses_bad_0005', 'prj_sample', NULL, 'sample-project', '/home/j/work/sample-project', 'Is the build green', '1.18.31', 200, 20, 0, 0, 0, 'build', '{"id":"sample-model","providerID":"sample-provider"}', 1790840000000, 1790840009000);

INSERT INTO message VALUES ('msg_bad_0001', 'ses_bad_0005', 1790840001000, 1790840001000,
  '{"role":"user","time":{"created":1790840001000}}');
INSERT INTO part VALUES ('prt_bad_0001', 'msg_bad_0001', 'ses_bad_0005', 1790840001000, 1790840001000,
  '{"type":"text","text":"Is the build green?"}');
INSERT INTO part VALUES ('prt_bad_0002', 'msg_bad_0001', 'ses_bad_0005', 1790840001001, 1790840001001,
  '{"type":"text","text":');
INSERT INTO part VALUES ('prt_bad_0003', 'msg_bad_0001', 'ses_bad_0005', 1790840001002, 1790840001002,
  '{"type":"text"}');
INSERT INTO part VALUES ('prt_bad_0004', 'msg_bad_0001', 'ses_bad_0005', 1790840001003, 1790840001003,
  '[1,2]');

INSERT INTO message VALUES ('msg_bad_0002', 'ses_bad_0005', 1790840002000, 1790840003000,
  'not json either');
INSERT INTO part VALUES ('prt_bad_0005', 'msg_bad_0002', 'ses_bad_0005', 1790840002100, 1790840002100,
  '{"type":"text","text":"A reply nobody can attribute."}');

INSERT INTO message VALUES ('msg_bad_0003', 'ses_bad_0005', 1790840004000, 1790840009000,
  '{"role":"assistant","parentID":"msg_bad_0001","agent":"build","time":{"created":1790840004000,"completed":1790840009000},"tokens":{"input":200,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_bad_0006', 'msg_bad_0003', 'ses_bad_0005', 1790840005000, 1790840008000,
  '{"type":"text","text":"Yes, all checks passed."}');

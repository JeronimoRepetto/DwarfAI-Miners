-- Usage (docs/opencode-format.md Rows 3 and 14): each assistant message carries its tokens, and
-- each of its steps repeats its own share in a step-finish part. The first reply took two steps,
-- so a reader keyed by part would count it twice. The second reply ended in an error and spent
-- nothing. session.tokens_* is the lifetime total: the sum over the session's assistant messages.
-- Synthetic (meta.json).
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
VALUES ('ses_usage_0004', 'prj_sample', NULL, 'sample-project', '/home/j/work/sample-project', 'Fix the lint error', '1.18.31', 1800, 150, 60, 4000, 200, 'build', '{"id":"sample-model","providerID":"sample-provider"}', 1790830000000, 1790830040000);

INSERT INTO message VALUES ('msg_usage_0001', 'ses_usage_0004', 1790830001000, 1790830001000,
  '{"role":"user","time":{"created":1790830001000}}');
INSERT INTO part VALUES ('prt_usage_0001', 'msg_usage_0001', 'ses_usage_0004', 1790830001000, 1790830001000,
  '{"type":"text","text":"Fix the lint error."}');

INSERT INTO message VALUES ('msg_usage_0002', 'ses_usage_0004', 1790830002000, 1790830020000,
  '{"role":"assistant","parentID":"msg_usage_0001","agent":"build","time":{"created":1790830002000,"completed":1790830020000},"tokens":{"total":5310,"input":1500,"output":100,"reasoning":60,"cache":{"read":3500,"write":150}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_usage_0002', 'msg_usage_0002', 'ses_usage_0004', 1790830002100, 1790830002100,
  '{"type":"step-start"}');
INSERT INTO part VALUES ('prt_usage_0003', 'msg_usage_0002', 'ses_usage_0004', 1790830002200, 1790830008000,
  '{"type":"tool","tool":"edit","callID":"call_0003","state":{"status":"completed","input":{"filePath":"src/index.ts"}}}');
INSERT INTO part VALUES ('prt_usage_0004', 'msg_usage_0002', 'ses_usage_0004', 1790830008100, 1790830008100,
  '{"type":"step-finish","reason":"tool-calls","tokens":{"input":900,"output":40,"reasoning":60,"cache":{"read":1500,"write":150}},"cost":0}');
INSERT INTO part VALUES ('prt_usage_0005', 'msg_usage_0002', 'ses_usage_0004', 1790830008200, 1790830008200,
  '{"type":"step-start"}');
INSERT INTO part VALUES ('prt_usage_0006', 'msg_usage_0002', 'ses_usage_0004', 1790830008300, 1790830019000,
  '{"type":"text","text":"Fixed: the unused import is gone."}');
INSERT INTO part VALUES ('prt_usage_0007', 'msg_usage_0002', 'ses_usage_0004', 1790830020000, 1790830020000,
  '{"type":"step-finish","reason":"stop","tokens":{"input":600,"output":60,"reasoning":0,"cache":{"read":2000,"write":0}},"cost":0}');

INSERT INTO message VALUES ('msg_usage_0003', 'ses_usage_0004', 1790830021000, 1790830021000,
  '{"role":"user","time":{"created":1790830021000}}');
INSERT INTO part VALUES ('prt_usage_0008', 'msg_usage_0003', 'ses_usage_0004', 1790830021000, 1790830021000,
  '{"type":"text","text":"Run the tests too."}');

INSERT INTO message VALUES ('msg_usage_0004', 'ses_usage_0004', 1790830022000, 1790830023000,
  '{"role":"assistant","parentID":"msg_usage_0003","agent":"build","time":{"created":1790830022000,"completed":1790830023000},"error":{"name":"ProviderError"},"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}');

INSERT INTO message VALUES ('msg_usage_0005', 'ses_usage_0004', 1790830030000, 1790830040000,
  '{"role":"assistant","parentID":"msg_usage_0003","agent":"build","time":{"created":1790830030000,"completed":1790830040000},"tokens":{"input":300,"output":50,"reasoning":0,"cache":{"read":500,"write":50}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_usage_0009', 'msg_usage_0005', 'ses_usage_0004', 1790830031000, 1790830039000,
  '{"type":"text","text":"All tests pass."}');
INSERT INTO part VALUES ('prt_usage_0010', 'msg_usage_0005', 'ses_usage_0004', 1790830040000, 1790830040000,
  '{"type":"step-finish","reason":"stop","tokens":{"input":300,"output":50,"reasoning":0,"cache":{"read":500,"write":50}},"cost":0}');

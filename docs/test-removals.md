# Test removals

The one place where a lost test statement is justified (testing strategy `17-testing-strategy.md` §2.6 of the
architecture package).

Every change runs the test census against its merge base:

```sh
node skills/test-safety/assets/test-census.mjs --base <merge-base>
```

When a test file loses statements (exit 1), the change passes only if it adds one row below for each losing file,
in the same change. The census gate reads this file, never the PR text, and a rising total never hides a loss. A
strangler cut runs the same census against its cut base (`--base <cut-base>`) and lists here every legacy test file
that leaves with its subject.

A row names:

- **File**: the test file that lost statements, as a repository path.
- **Statements removed**: the statements that left, with their count and test titles.
- **Reason**: why they went.
- **Removed by issue**: the issue whose change removed the subject.
- **Coverage now lives in**: the test file, and the test titles, that now prove the behaviour.

The file is append-only: add rows at the end, one entry per PR, and never edit or delete a row.

| File | Statements removed | Reason | Removed by issue | Coverage now lives in |
| ---- | ------------------ | ------ | ---------------- | --------------------- |

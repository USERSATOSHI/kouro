Validate the supplied task against the plan, change report, and scout findings.
Inspect the actual changed files and diff using the supplied repository context.
Remain read-only: do not repair files or perform publishing actions.

Check the task's acceptance criteria, scope, and relevant verification evidence.
For documentation, check that commands, APIs, examples, and relative links match
the current implementation. Separate supported behavior from known limitations.
Scout recommendations and worker claims are not independent proof of execution.

Run safe read-only checks when available, and report exactly which checks ran,
their results, and which checks remain unverified. Explicitly identify defects
or inaccessible source. Return only JSON matching Summary:
{ "summary": "PASS or ISSUES, findings, verification evidence, and remaining work" }.

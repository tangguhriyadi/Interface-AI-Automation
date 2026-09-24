# Third-party configuration

The agent and command definition in this directory are copied from
Everything Claude Code (ECC), MIT-licensed:
https://github.com/affaan-m/ECC, version v2.2.1

Only the planner agent and its /plan command are kept, because they are the
only parts that were actually used. The rest of the ECC catalog, including
its hooks and rules, was never installed. A tdd-workflow skill and a
code-review command were installed at the start and later removed, having
gone unused: the skill mandates 80%+ coverage, which conflicts with this
project's own rule to test where it counts rather than chase a coverage
number (see CLAUDE.md).

These two files are not my work. CLAUDE.md in the repo root is.

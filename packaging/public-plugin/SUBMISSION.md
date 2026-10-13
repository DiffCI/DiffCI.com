# DiffCI public plugin submission

`plugin.json` packages the hosted, read-only DiffCI MCP endpoint for the
shared Codex and ChatGPT plugin directory. It intentionally does not package
the local stdio server: a public remote MCP connection cannot access a user's
checkout or execute a repository test command.

Before uploading this directory as a ZIP:

1. Commit and push this directory, including its review artifact, to the release
   ref. Confirm the raw GitHub review-artifact URL in `plugin.json` is readable.
2. Release the matching `@diffci.com/diffci` version and deploy the matching
   `https://diffci.com/mcp/v1` endpoint and public terms page.
3. Confirm the public support, data-handling, and terms URLs resolve over HTTPS.
4. Record an accessible walkthrough that runs the five positive review cases in
   `plugin.json`; add its URL in the OpenAI submission portal.
5. Complete the three negative cases, identity verification, domain challenge,
   MCP connection scan, and reviewer checks in the portal.

The review cases deliberately show the hosted boundary. Use
`packaging/agent-plugin` for local checkout inspection and test execution.

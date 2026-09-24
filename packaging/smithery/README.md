# DiffCI Smithery bundle

This manifest packages the published `@diffci.com/diffci` npm release as a local MCP bundle for Smithery.

The bundle runs the existing stdio MCP server locally. It can inspect local and uncommitted Git changes and does not send repository data to DiffCI Cloud.

For each DiffCI release, update the version in `manifest.json`, stage that exact npm package with production dependencies, validate with `mcpb validate`, and pack with `mcpb pack`.

# Security

Please report security issues privately through the contact options at https://getlinkbunny.com/about rather than in a public issue.

The action needs no `GITHUB_TOKEN` permissions or secrets. It sends only the `page-url` and `expected-url` inputs to `https://mcp.getlinkbunny.com/mcp`. Page content in the job summary and log is escaped and treated as data. Pin the action to a full commit SHA if you want to control exactly what runs.

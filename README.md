# LinkBunny Backlink Placement Check

This GitHub Action checks that one published page links to one URL you expect. It also checks the link's `rel=nofollow` and, optionally, its anchor text. The step fails when the link is missing or doesn't match. Use it after a deploy to catch a link that a template change, CMS edit or content rewrite removed.

The action calls [LinkBunny's](https://getlinkbunny.com) free hosted checker, the same one behind the [backlink placement checker](https://getlinkbunny.com/tools/backlink-placement-checker) and the `inspect_placement` tool on `https://mcp.getlinkbunny.com/mcp`. You don't need an account, subscription or token, and the action doesn't need any `GITHUB_TOKEN` permissions.

## Usage

```yaml
name: Check backlink placement

on:
  workflow_dispatch:
  push:
    branches: [main]

permissions: {}

jobs:
  placement:
    runs-on: ubuntu-latest
    steps:
      # Deploy first, then check the live page.
      - id: placement
        uses: hboon/linkbunny-backlink-placement-check@v1
        with:
          page-url: https://example.com/resources
          expected-url: https://partner.example.org/
          expected-anchor-text: Partner Example
      - if: always()
        run: echo "Placement check result $RESULT, reason $REASON"
        env:
          RESULT: ${{ steps.placement.outputs.result }}
          REASON: ${{ steps.placement.outputs.reason }}
```

For stricter supply-chain control, pin the action to a full commit SHA instead of `@v1`.

## Inputs

| Input                  | Required | Default | Description                                                                                                                                  |
| ---------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `page-url`             | yes      |         | Public HTTPS page that should contain the link.                                                                                              |
| `expected-url`         | yes      |         | Public HTTPS URL the link should point to.                                                                                                   |
| `expected-anchor-text` | no       | `""`    | Exact anchor text after collapsing whitespace. Case-sensitive. At least one matching link must have it.                                      |
| `require-nofollow`     | no       | `true`  | Fail unless every link to `expected-url` has `rel=nofollow`. Set it to `false` to check only that the link is present.                       |
| `fail-on-error`        | no       | `true`  | Fail the step when the check can't be completed. When `false`, the step passes with a warning, but a missing or mismatched link still fails. |

Only use public URLs. Leave out URLs that contain tokens, signed parameters or personal data.

## Outputs

| Output           | Values                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result`         | `pass`, `fail` or `error`                                                                                                                                                                                                                       |
| `reason`         | `link_present`, `link_missing`, `nofollow_missing`, `anchor_mismatch`, `source_not_inspected`, `source_partially_inspected`, `invalid_input`, `invalid_request`, `check_failed`, `rate_limited`, `unavailable`, `timeout` or `invalid_response` |
| `match-count`    | Number of links to `expected-url` in the fetched HTML, up to 100. Empty when the checker returned no result.                                                                                                                                    |
| `nofollow-count` | Number of those links with `rel=nofollow`. Empty when the checker returned no result.                                                                                                                                                           |

Outputs contain only these fixed values and counts, never text from the checked page. The job summary and log list each matching link's anchor text, `rel` values, `nofollow` and `href`. Page text there is escaped and treated as data.

## Pass, fail and error

- `pass`: the fetched HTML links to `expected-url`, every such link has `rel=nofollow` (unless `require-nofollow` is `false`), and one has the expected anchor text if you set it.
- `fail`: no link to `expected-url` in the fetched HTML (`link_missing`), a link without `nofollow` (`nofollow_missing`) or no link with the expected anchor text (`anchor_mismatch`).
- `error`: the check couldn't be completed. For example, the page returned a 404 or couldn't be fetched (`source_not_inspected`), the page had over 5,000 links and no match among those inspected (`source_partially_inspected`), the shared checker hit its rate limit (`rate_limited`) or was overloaded or unreachable (`unavailable`), or it didn't answer within 30 seconds (`timeout`). An error doesn't mean the link is missing. The action doesn't retry.

## Limits

- It reads fetched HTML only and doesn't run JavaScript. A link that only appears after the page renders counts as missing.
- Links to `expected-url` also match URLs in its redirect chain. If `expected-url` now redirects elsewhere, a link to the redirect target also passes. Links with a different path or query string don't match.
- The summary shows the HTTP status of `expected-url`, but the result doesn't depend on it.
- The checker returns at most 100 matching links, and the `nofollow` requirement applies to those.
- One run checks one page and one destination. Add more steps for more links. It doesn't crawl or schedule checks.
- The hosted checker is shared by everyone and rate-limited. Run it after deploys or on demand, not on a tight schedule. Set `fail-on-error: false` if a busy checker shouldn't block your workflow.
- It says nothing about indexing, rankings or how long a link will stay up.
- It can't edit sites or repositories, and it can't access LinkBunny accounts.

## Privacy, terms and support

The action sends the two URLs to `https://mcp.getlinkbunny.com/mcp` and nothing else. It sends no repository data, secrets or tokens.

- Privacy policy: https://getlinkbunny.com/privacy
- Terms: https://getlinkbunny.com/terms
- Support and contact: https://getlinkbunny.com/about

## License

MIT (see `LICENSE`). The LinkBunny name isn't licensed for reuse.

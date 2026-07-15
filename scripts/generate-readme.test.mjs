import assert from "node:assert/strict";
import test from "node:test";

import {
  humanize,
  markdownText,
  renderReadme,
  repositoryNameFromUrl,
} from "./generate-readme.mjs";

const now = new Date("2026-07-15T12:00:00Z");

test("humanize uses stable day-sized buckets", () => {
  assert.equal(humanize("2026-07-15T01:00:00Z", now), "today");
  assert.equal(humanize("2026-07-14T23:59:00Z", now), "1 day ago");
  assert.equal(humanize("2026-07-08T00:00:00Z", now), "1 week ago");
  assert.equal(humanize("2026-06-24T00:00:00Z", now), "3 weeks ago");
});

test("repositoryNameFromUrl supports API and HTML repository URLs", () => {
  assert.equal(
    repositoryNameFromUrl("https://api.github.com/repos/open-policy-agent/gatekeeper"),
    "open-policy-agent/gatekeeper",
  );
  assert.equal(
    repositoryNameFromUrl("https://github.com/open-policy-agent/gatekeeper/pull/1"),
    "open-policy-agent/gatekeeper",
  );
});

test("markdownText escapes markup-sensitive characters", () => {
  assert.equal(markdownText("a [small] <tool>"), "a \\[small\\] &lt;tool&gt;");
});

test("renderReadme renders every generated section", () => {
  const repository = {
    description: "Example repository",
    full_name: "sozercan/example",
    html_url: "https://github.com/sozercan/example",
  };
  const output = renderReadme(
    {
      contributions: [{ occurredAt: "2026-07-14T12:00:00Z", repository }],
      projects: [repository],
      pullRequests: [
        {
          createdAt: "2026-07-13T12:00:00Z",
          repository: "sozercan/example",
          title: "fix: example",
          url: "https://github.com/sozercan/example/pull/1",
        },
      ],
      releases: [
        {
          release: {
            html_url: "https://github.com/sozercan/example/releases/tag/v1.0.0",
            published_at: "2026-07-15T01:00:00Z",
            tag_name: "v1.0.0",
          },
          repository,
        },
      ],
      stars: [{ repository, starredAt: "2026-07-12T12:00:00Z" }],
      user: "sozercan",
    },
    now,
  );

  assert.match(output, /#### 🌱 My latest projects/);
  assert.match(output, /#### 👷 Check out what I'm currently working on/);
  assert.match(output, /#### 🔨 My recent Pull Requests/);
  assert.match(output, /#### 🚀 Latest releases I've contributed to/);
  assert.match(output, /#### ⭐ Recent Stars/);
  assert.match(output, /fix: example/);
  assert.match(output, /v1\.0\.0/);
  assert.match(output, /username=sozercan/);
});

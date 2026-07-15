#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = process.env.GITHUB_API_URL ?? "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const USER_AGENT = "sozercan-profile-readme";
const API_VERSION = "2022-11-28";

const LIMITS = Object.freeze({
  contributions: 15,
  commitSearchPages: 5,
  projects: 15,
  pullRequests: 10,
  releaseCandidates: 30,
  releases: 10,
  stars: 10,
});

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function responseMessage(response) {
  const text = await response.text();
  if (!text) {
    return response.statusText;
  }

  try {
    const body = JSON.parse(text);
    return body.message ?? text;
  } catch {
    return text;
  }
}

async function requestJson(path, { accept = "application/vnd.github+json", optional = false } = {}) {
  const url = new URL(path, API_ROOT);
  const authenticationModes = TOKEN ? [true, false] : [false];
  let lastError;

  for (const authenticated of authenticationModes) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const headers = {
        Accept: accept,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      };

      if (authenticated) {
        headers.Authorization = `Bearer ${TOKEN}`;
      }

      let response;
      try {
        response = await fetch(url, { headers });
      } catch (error) {
        lastError = new Error(`GitHub request failed for ${url.pathname}: ${error.message}`);
        if (attempt < 2) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        break;
      }

      if (response.ok) {
        return response.json();
      }

      const message = await responseMessage(response);
      lastError = new Error(`GitHub API ${response.status} for ${url.pathname}: ${message}`);
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const rateLimited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
      const retryable = rateLimited || [500, 502, 503, 504].includes(response.status);

      if (retryable && attempt < 2) {
        await sleep(Math.max(retryAfter * 1000, 500 * 2 ** attempt));
        continue;
      }

      // GITHUB_TOKEN is repository-scoped. Public endpoints can be retried
      // without authentication when an installation token cannot see a resource.
      if (authenticated && [401, 403, 404].includes(response.status)) {
        break;
      }

      if (optional && response.status === 404) {
        return null;
      }

      throw lastError;
    }
  }

  if (optional && lastError?.message.includes("GitHub API 404")) {
    return null;
  }

  throw lastError ?? new Error(`GitHub request failed for ${url.pathname}`);
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function fallbackRepository(fullName) {
  return {
    description: "",
    fork: false,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    name: fullName.split("/").at(-1),
    stargazers_count: 0,
  };
}

export function repositoryNameFromUrl(repositoryUrl) {
  if (!repositoryUrl) {
    return "";
  }

  const parts = new URL(repositoryUrl).pathname.split("/").filter(Boolean);
  const reposIndex = parts.indexOf("repos");
  if (reposIndex >= 0 && parts.length > reposIndex + 2) {
    return `${parts[reposIndex + 1]}/${parts[reposIndex + 2]}`;
  }

  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return "";
}

export function markdownText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function humanize(timestamp, now = new Date()) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const startOfDate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.max(0, Math.floor((startOfToday - startOfDate) / 86_400_000));

  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "1 month ago";
  if (days < 365) return `${Math.floor(days / 30)} months ago`;

  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

function repositoryLine(repository, occurredAt, now) {
  const name = markdownText(repository.full_name);
  const description = markdownText(repository.description);
  const age = humanize(occurredAt, now);
  const descriptionSuffix = description ? ` - ${description}` : "";
  const ageSuffix = age ? ` (${age})` : "";
  return `- [${name}](${repository.html_url})${descriptionSuffix}${ageSuffix}`;
}

export function renderReadme({ projects, contributions, pullRequests, releases, stars, user }, now = new Date()) {
  const lines = ["#### 🌱 My latest projects", ""];

  lines.push(...projects.map((repository) => repositoryLine(repository, null, now)));
  lines.push("", "#### 👷 Check out what I'm currently working on", "");
  lines.push(...contributions.map(({ occurredAt, repository }) => repositoryLine(repository, occurredAt, now)));
  lines.push("", "#### 🔨 My recent Pull Requests", "");
  lines.push(
    ...pullRequests.map((pullRequest) => {
      const title = markdownText(pullRequest.title);
      const repository = markdownText(pullRequest.repository);
      const age = humanize(pullRequest.createdAt, now);
      return `- [${title}](${pullRequest.url}) on [${repository}](https://github.com/${pullRequest.repository}) (${age})`;
    }),
  );
  lines.push("", "#### 🚀 Latest releases I've contributed to", "");
  lines.push(
    ...releases.map(({ release, repository }) => {
      const repositoryName = markdownText(repository.full_name);
      const tagName = markdownText(release.tag_name);
      const description = markdownText(repository.description);
      const descriptionSuffix = description ? ` - ${description}` : "";
      const age = humanize(release.published_at, now);
      return `- [${repositoryName}](${repository.html_url}) ([${tagName}](${release.html_url}), ${age})${descriptionSuffix}`;
    }),
  );
  lines.push("", "#### ⭐ Recent Stars", "");
  lines.push(...stars.map(({ repository, starredAt }) => repositoryLine(repository, starredAt, now)));
  lines.push(
    "",
    `![](https://github-readme-stats.vercel.app/api?username=${encodeURIComponent(user)}&theme=vision-friendly-dark&hide_border=false&include_all_commits=true&count_private=true)`,
    "",
  );

  return lines.join("\n");
}

async function loadRecentCommitActivity(user, profileRepository) {
  const activityByRepository = new Map();

  for (let page = 1; page <= LIMITS.commitSearchPages; page += 1) {
    const searchResult = await requestJson(
      `/search/commits?q=${encodeURIComponent(`author:${user}`)}&sort=committer-date&order=desc&per_page=100&page=${page}`,
    );

    for (const item of searchResult.items) {
      const repositoryName = item.repository?.full_name;
      const key = repositoryName?.toLowerCase();
      const occurredAt = item.commit?.committer?.date ?? item.commit?.author?.date;

      if (!repositoryName || !occurredAt || key === profileRepository || activityByRepository.has(key)) {
        continue;
      }

      activityByRepository.set(key, { occurredAt, repositoryName });
    }

    if (activityByRepository.size >= LIMITS.contributions || searchResult.items.length < 100) {
      break;
    }
  }

  return [...activityByRepository.values()].slice(0, LIMITS.contributions);
}

async function main() {
  const user = process.env.GITHUB_USER ?? process.env.GITHUB_REPOSITORY_OWNER ?? "sozercan";
  const profileRepository = `${user}/${user}`.toLowerCase();
  const repositoryCache = new Map();

  const [ownedRepositories, contributionActivity, pullRequestSearch, rawStars] = await Promise.all([
    requestJson(`/users/${encodeURIComponent(user)}/repos?type=owner&sort=created&direction=desc&per_page=100`),
    loadRecentCommitActivity(user, profileRepository),
    requestJson(
      `/search/issues?q=${encodeURIComponent(`author:${user} is:pr`)}&sort=created&order=desc&per_page=100`,
    ),
    requestJson(`/users/${encodeURIComponent(user)}/starred?sort=created&direction=desc&per_page=${LIMITS.stars}`, {
      accept: "application/vnd.github.star+json",
    }),
  ]);

  for (const repository of ownedRepositories) {
    repositoryCache.set(repository.full_name.toLowerCase(), repository);
  }

  const projects = ownedRepositories
    .filter((repository) => !repository.fork && repository.full_name.toLowerCase() !== profileRepository)
    .slice(0, LIMITS.projects);

  const allPullRequests = pullRequestSearch.items
    .map((pullRequest) => ({
      createdAt: pullRequest.created_at,
      repository: repositoryNameFromUrl(pullRequest.repository_url),
      title: pullRequest.title,
      url: pullRequest.html_url,
    }))
    .filter(
      (pullRequest) =>
        pullRequest.repository && pullRequest.repository.toLowerCase() !== profileRepository,
    );
  const pullRequests = allPullRequests.slice(0, LIMITS.pullRequests);

  async function getRepository(fullName) {
    const key = fullName.toLowerCase();
    if (repositoryCache.has(key)) {
      return repositoryCache.get(key);
    }

    const repository =
      (await requestJson(`/repos/${fullName}`, { optional: true })) ?? fallbackRepository(fullName);
    repositoryCache.set(key, repository);
    return repository;
  }

  const contributions = await mapLimit(contributionActivity, 5, async ({ occurredAt, repositoryName }) => ({
    occurredAt,
    repository: await getRepository(repositoryName),
  }));

  const releaseCandidateNames = [];
  const seenReleaseCandidates = new Set();
  for (const repositoryName of [
    ...contributionActivity.map((activity) => activity.repositoryName),
    ...allPullRequests.map((pullRequest) => pullRequest.repository),
  ]) {
    const key = repositoryName.toLowerCase();
    if (key === profileRepository || seenReleaseCandidates.has(key)) {
      continue;
    }
    seenReleaseCandidates.add(key);
    releaseCandidateNames.push(repositoryName);
    if (releaseCandidateNames.length >= LIMITS.releaseCandidates) {
      break;
    }
  }

  const releaseResults = await mapLimit(releaseCandidateNames, 6, async (repositoryName) => {
    try {
      const release = await requestJson(`/repos/${repositoryName}/releases/latest`, { optional: true });
      if (!release || release.draft || release.prerelease || !release.published_at) {
        return null;
      }
      return {
        release,
        repository: await getRepository(repositoryName),
      };
    } catch (error) {
      console.warn(`Skipping releases for ${repositoryName}: ${error.message}`);
      return null;
    }
  });

  const releases = releaseResults
    .filter(Boolean)
    .sort((left, right) => {
      const dateDifference = new Date(right.release.published_at) - new Date(left.release.published_at);
      return dateDifference || right.repository.stargazers_count - left.repository.stargazers_count;
    })
    .slice(0, LIMITS.releases);

  const stars = rawStars.slice(0, LIMITS.stars).map((entry) => ({
    repository: entry.repo ?? entry,
    starredAt: entry.starred_at ?? null,
  }));

  const readme = renderReadme(
    {
      contributions,
      projects,
      pullRequests,
      releases,
      stars,
      user,
    },
    new Date(),
  );

  await writeFile("README.md", readme, "utf8");
  console.log(
    `Updated README.md with ${projects.length} projects, ${contributions.length} active repositories, ` +
      `${pullRequests.length} pull requests, ${releases.length} releases, and ${stars.length} stars.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

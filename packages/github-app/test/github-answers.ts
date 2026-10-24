// GitHub's answers, shaped like the examples in its REST API's description
// (github/rest-api-description, descriptions/api.github.com/api.github.com.json, version 2022-11-28),
// with fewer of their fields and values of these tests' own. Written by hand: tests never call GitHub.

const repo = "https://api.github.com/repos/octocat/Hello-World"
const page = "https://github.com/octocat/Hello-World"

const account = (login: string, id: number) => ({
  login,
  id,
  node_id: "MDQ6VXNlcjE=",
  avatar_url: "https://github.com/images/error/octocat_happy.gif",
  url: `https://api.github.com/users/${login}`,
  html_url: `https://github.com/${login}`,
  type: "User",
  site_admin: false,
})

/** What GitHub answers when it doesn't answer what was asked. */
export const errorJson = (message: string, status: number) => ({
  message,
  documentation_url: "https://docs.github.com/rest",
  status: String(status),
})

/** `GET /repos/{owner}/{repo}`: the repository, with fewer of its fields. */
export const repositoryJson = {
  id: 1296269,
  node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
  name: "Hello-World",
  full_name: "octocat/Hello-World",
  owner: account("octocat", 1),
  private: false,
  html_url: page,
  url: repo,
  default_branch: "main",
}

/** A GitHub App's installation on an account, with fewer of its fields. */
export const installationJson = (installation: {
  readonly id: number
  readonly login: string
  readonly type: "User" | "Organization"
  readonly selection: "all" | "selected"
}) => ({
  id: installation.id,
  account: { ...account(installation.login, 2), type: installation.type },
  repository_selection: installation.selection,
  access_tokens_url: `https://api.github.com/app/installations/${installation.id}/access_tokens`,
  repositories_url: "https://api.github.com/installation/repositories",
  html_url:
    installation.type === "Organization"
      ? `https://github.com/organizations/${installation.login}/settings/installations/${installation.id}`
      : `https://github.com/settings/installations/${installation.id}`,
  app_id: 123456,
  app_slug: "notes-releases",
  target_id: 2,
  target_type: installation.type,
  permissions: { actions: "write", contents: "read", metadata: "read" },
  events: [],
  created_at: "2026-10-01T09:00:00Z",
  updated_at: "2026-10-01T09:00:00Z",
  single_file_name: null,
  suspended_at: null,
  suspended_by: null,
})

/** `POST /app/installations/{installation_id}/access_tokens`: a token, of the tests' own. */
export const installationTokenJson = (token: string, expiresAt: string) => ({
  token,
  expires_at: expiresAt,
  permissions: { actions: "write", contents: "read", metadata: "read" },
  repository_selection: "all",
})

/** `POST /app-manifests/{code}/conversions`: the app created, its secrets the tests' own. */
export const manifestConversionJson = (secrets: { readonly pem: string; readonly webhookSecret: string | null }) => ({
  id: 123456,
  slug: "notes-releases",
  node_id: "MDxOkludGVncmF0aW9uMQ==",
  owner: account("octocat", 1),
  name: "Notes releases",
  description: "",
  external_url: "https://example.com",
  html_url: "https://github.com/apps/notes-releases",
  created_at: "2026-10-22T10:00:00Z",
  updated_at: "2026-10-22T10:00:00Z",
  permissions: { actions: "write", contents: "read", metadata: "read" },
  events: [],
  client_id: "Iv23liTestClientNotReal",
  client_secret: "test-client-secret-not-a-real-one",
  webhook_secret: secrets.webhookSecret,
  pem: secrets.pem,
})

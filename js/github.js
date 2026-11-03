import { assertRepoPath, CONTENT_BRANCH, mapPool, validBranch, validOwner } from "./util.js";

const API = "https://api.github.com";

export function treeEntries({ textFiles = [], blobs = [], deletions = [] }) {
  return [
    ...textFiles.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.text,
    })),
    ...blobs.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: file.sha,
    })),
    ...deletions.map((path) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    })),
  ];
}

export function refPath(branch) {
  if (!validBranch(branch)) throw new Error("分支名不正确。");
  return `heads/${branch}`;
}

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    if (!validOwner(owner) || !validOwner(repo)) {
      throw new Error("用户名或仓库名格式不对。");
    }
    if (!validBranch(branch || "main")) throw new Error("分支名不正确。");
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
    this.token = token || "";
  }

  repoPath(suffix) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  async request(method, path, { body } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("连接 GitHub 超时。");
      throw new Error("连不上 GitHub。浏览器需要能直接访问 api.github.com。");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await toError(response);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async connectInfo() {
    const user = await this.request("GET", "/user");
    let repo;
    try {
      repo = await this.request("GET", this.repoPath(""));
    } catch (error) {
      if (error.status === 404) throw new Error("找不到这座仓库，或令牌无权访问。");
      throw error;
    }

    try {
      await this.request("GET", this.repoPath(`/git/ref/${refPath(this.branch)}`));
    } catch (error) {
      if (error.status === 409) throw new Error("仓库还是空的。请先把这个网页提交上去。");
      if (error.status === 404) {
        throw new Error(`找不到分支 ${this.branch}。这座仓库的默认分支是 ${repo.default_branch || "main"}。`);
      }
      throw error;
    }

    let pagesUrl = "";
    let pagesState = "unknown";
    try {
      const pages = await this.request("GET", this.repoPath("/pages"));
      pagesUrl = pages?.html_url || "";
      pagesState = pagesUrl ? "on" : "unknown";
    } catch (error) {
      pagesState = error.status === 404 ? "off" : "unknown";
    }

    return {
      login: user.login,
      name: user.name || user.login,
      avatar: user.avatar_url || "",
      canPush: Boolean(repo.permissions?.push),
      privateRepo: Boolean(repo.private),
      pagesUrl,
      pagesState,
    };
  }

  async getTextFile(path, branch = this.branch) {
    assertRepoPath(path);
    try {
      const data = await this.request(
        "GET",
        this.repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`),
      );
      if (!data || Array.isArray(data)) return null;
      return {
        text: data.content ? decodeBase64Utf8(data.content) : "",
        sha: data.sha,
      };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async getImageObjectUrl(path, branch = this.branch) {
    assertRepoPath(path);
    const data = await this.request(
      "GET",
      this.repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`),
    );
    if (!data?.content) throw new Error("读不到照片。");
    const bytes = base64ToBytes(data.content);
    return URL.createObjectURL(new Blob([bytes], { type: mimeFromName(data.name || path) }));
  }

  async commit({ message, textFiles = [], binaries = [], deletions = [], onProgress, branch }) {
    for (const file of textFiles) assertRepoPath(file.path);
    for (const file of binaries) assertRepoPath(file.path);
    for (const path of deletions) assertRepoPath(path);
    const target = branch || this.branch;
    if (!validBranch(target)) throw new Error("分支名不正确。");
    if (target !== this.branch) {
      const base = await this.head();
      await this.ensureBranch(target, base.commitSha);
    }

    let done = 0;
    const blobs = await mapPool(binaries, 3, async (file) => {
      const blob = await this.request("POST", this.repoPath("/git/blobs"), {
        body: { content: file.base64, encoding: "base64" },
      });
      done += 1;
      onProgress?.({ phase: "upload", current: done, total: binaries.length });
      return { path: file.path, sha: blob.sha };
    });

    try {
      return await this.writeCommit({ message, textFiles, blobs, deletions, onProgress, branch: target });
    } catch (error) {
      if (!error.retryable) throw error;
      onProgress?.({ phase: "retry" });
      try {
        return await this.writeCommit({ message, textFiles, blobs, deletions, onProgress, branch: target });
      } catch (again) {
        if (again.status === 422 || again.status === 409) {
          throw new Error("远端分支刚被更新过，请再发布一次。");
        }
        throw again;
      }
    }
  }

  async writeCommit({ message, textFiles, blobs, deletions, onProgress, branch = this.branch }) {
    onProgress?.({ phase: "commit" });
    const head = await this.head(branch);
    let remove = [];
    if (deletions.length) {
      const existing = new Set(await this.listBlobPaths(head.treeSha));
      const writing = new Set([...textFiles.map((file) => file.path), ...blobs.map((file) => file.path)]);
      remove = deletions.filter((path) => existing.has(path) && !writing.has(path));
    }
    const tree = await this.request("POST", this.repoPath("/git/trees"), {
      body: {
        base_tree: head.treeSha,
        tree: treeEntries({ textFiles, blobs, deletions: remove }),
      },
    });
    const created = await this.request("POST", this.repoPath("/git/commits"), {
      body: {
        message: message || "更新旅行记录",
        tree: tree.sha,
        parents: [head.commitSha],
      },
    });
    try {
      await this.request("PATCH", this.repoPath(`/git/refs/${refPath(branch)}`), {
        body: { sha: created.sha },
      });
    } catch (error) {
      if (error.status === 422 || error.status === 409) error.retryable = true;
      throw error;
    }
    return created.sha;
  }

  async head(branch = this.branch) {
    const ref = await this.request("GET", this.repoPath(`/git/ref/${refPath(branch)}`));
    const commit = await this.request("GET", this.repoPath(`/git/commits/${ref.object.sha}`));
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  async ensureBranch(branch, fromSha) {
    try {
      return await this.head(branch);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    try {
      await this.request("POST", this.repoPath("/git/refs"), {
        body: { ref: `refs/${refPath(branch)}`, sha: fromSha },
      });
    } catch (error) {
      if (error.status !== 422) throw error;
    }
    return this.head(branch);
  }

  async listBlobPaths(treeSha) {
    const data = await this.request("GET", this.repoPath(`/git/trees/${treeSha}?recursive=1`));
    if (data.truncated) throw new Error("仓库文件太多，这次没法安全地删除旧文件。");
    return (data.tree || []).filter((item) => item.type === "blob").map((item) => item.path);
  }
}

export async function publicContentHead({ owner, repo, siteBranch }) {
  if (!validOwner(owner) || !validOwner(repo)) throw new Error("用户名或仓库名格式不对。");
  const contentSha = await publicCommit(owner, repo, CONTENT_BRANCH);
  if (contentSha) return { sha: contentSha, branch: CONTENT_BRANCH };
  const branch = siteBranch || "main";
  const siteSha = await publicCommit(owner, repo, branch);
  if (siteSha) return { sha: siteSha, branch };
  throw new Error("读不到旅行记录。");
}

export function rawContentUrl(owner, repo, sha, path) {
  assertRepoPath(path);
  if (!validOwner(owner) || !validOwner(repo) || !/^[0-9a-f]{40}$/.test(sha || "")) {
    throw new Error("读不到旅行记录。");
  }
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${encoded}`;
}

async function publicCommit(owner, repo, branch) {
  if (!validBranch(branch)) throw new Error("分支名不正确。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(
      `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${refPath(branch)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-cache",
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("连接 GitHub 超时。");
    throw new Error("连不上 GitHub。浏览器需要能直接访问 api.github.com。");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return "";
  if (!response.ok) throw await toError(response);
  const data = await response.json();
  const sha = data?.object?.sha || "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("读不到旅行记录。");
  return sha;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeBase64Utf8(value) {
  return new TextDecoder().decode(base64ToBytes(value));
}

function base64ToBytes(value) {
  const binary = atob(String(value).replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mimeFromName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function toError(response) {
  let message = response.statusText || "GitHub 请求失败。";
  try {
    const data = await response.json();
    if (data?.message) message = data.message;
  } catch {
    // 保留状态码对应的简短说明。
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    message = "GitHub 接口次数用完了，等一会儿再试。";
  }
  const error = new Error(message);
  error.status = response.status;
  return error;
}

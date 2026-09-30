/** Exact equivalent GitHub origins; no userinfo, queries, rewrites, or other hosts. */
export function sameWorkspaceRepository(remote: string | null, repositorySsh: string) {
  if (!/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repositorySsh)) return false;
  const https = repositorySsh.replace(/^git@github\.com:/, "https://github.com/");
  return [repositorySsh, https, https.replace(/\.git$/, "")].includes(remote ?? "");
}

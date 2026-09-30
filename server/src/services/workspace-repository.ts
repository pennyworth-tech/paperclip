/** Compare a workspace URL to its canonical GitHub repository identity. */
export function sameWorkspaceRepository(metadata: string | null, repositorySsh: string) {
  return metadata?.replace(/^https:\/\/github\.com\//, "git@github.com:").replace(/\.git$/, "") === repositorySsh.replace(/\.git$/, "");
}

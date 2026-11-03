// Releases stay local until an owned update repository is explicitly configured.
export function resolveDesktopPublishConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawRepo = env.VIBEINATOR_UPDATE_REPOSITORY?.trim();
  if (!rawRepo) return undefined;
  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error("VIBEINATOR_UPDATE_REPOSITORY must be owner/repository.");
  }
  return { provider: "github" as const, owner, repo, releaseType: "release" as const };
}

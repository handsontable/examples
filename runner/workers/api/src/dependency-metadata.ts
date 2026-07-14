export interface DependencyMetadata {
  packageJson: string | undefined;
  pnpmLock: string | undefined;
}

/**
 * Serialize dependency metadata unambiguously. Explicit markers ensure an absent
 * lockfile cannot collide with an empty lockfile or a package file's contents.
 */
export function dependencyMetadataInput({ packageJson, pnpmLock }: DependencyMetadata): string {
  const part = (name: string, value: string | undefined) =>
    value === undefined ? `${name}:missing\n` : `${name}:${value.length}:${value}\n`;
  return `${part("package.json", packageJson)}${part("pnpm-lock.yaml", pnpmLock)}`;
}

/** SHA-256 fingerprint using the Web Crypto API available in Cloudflare Workers. */
export async function dependencyMetadataFingerprint(metadata: DependencyMetadata): Promise<string> {
  const bytes = new TextEncoder().encode(dependencyMetadataInput(metadata));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

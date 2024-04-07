export const RUST_ARTIFACT_S3_KEY_PARAM_NAME = "rustartifacts3key";

export function buildRustArtifactKey(executionId: string) {
    return `bootstrap-${executionId}`
}
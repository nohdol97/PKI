// The two projection job kinds (I03-R7) and what sets them apart from every other
// kind that names a source: they run after the source is gone, so they carry no
// version fence (a fence would close every one as superseded, the source having no
// version left). jobs.ts judges the fence only for the kinds this says use one.
/** The job each new source version gets (V02-T05); a scope change may queue one more (I04-R15). */
export const EXTRACT_JOB_KIND = "extract";
export const PROJECTION_REMOVE_KIND = "projection-remove";
export const PROJECTION_REBUILD_KIND = "projection-rebuild";

export const FENCE_FREE_KINDS: readonly string[] = [
  PROJECTION_REMOVE_KIND,
  PROJECTION_REBUILD_KIND,
];

/** False for the projection kinds: their source and version are a name and a cover, not a fence. */
export const usesVersionFence = (kind: string): boolean => !FENCE_FREE_KINDS.includes(kind);

import { FileTag, type UploadTagsInput } from "@shared/types";

export function parseUploadTags(raw: string | null): UploadTagsInput | undefined {
  if (raw === null) return undefined;

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid tags payload");
  }

  const invalidTag = parsed.find((tag) => !Object.values(FileTag).includes(tag));
  if (invalidTag) {
    throw new Error(`Invalid tag: ${String(invalidTag)}`);
  }

  return parsed as UploadTagsInput;
}

export function normalizeUploadTags(
  tags?: UploadTagsInput,
  options?: { forceNsfw?: boolean },
): FileTag[] {
  const result = new Set<FileTag>();

  for (const tag of tags ?? []) {
    if (Object.values(FileTag).includes(tag)) {
      result.add(tag);
    }
  }

  if (options?.forceNsfw) {
    result.add(FileTag.NSFW);
  }

  return [...result];
}

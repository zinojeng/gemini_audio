export function stripCodeFences(payload) {
  if (typeof payload !== "string") {
    return payload;
  }

  const trimmed = payload.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9+\-]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const altFenceMatch = trimmed.match(/^```([\s\S]*?)```$/);
  if (altFenceMatch) {
    return altFenceMatch[1].trim();
  }

  return trimmed;
}

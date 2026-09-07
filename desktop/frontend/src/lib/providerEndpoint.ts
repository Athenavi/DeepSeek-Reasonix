export interface ProviderEndpointConfig {
  kind: string;
  baseUrl: string;
  requestUrl?: string;
  chatUrl?: string;
}

export function trimmedBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function providerRequestURLFromConfig(
  kind: string,
  baseUrl: string,
  requestUrl: string,
  legacyChatUrl = "",
): string {
  const exactRequestURL = requestUrl.trim();
  if (exactRequestURL) return exactRequestURL;
  if (kind.trim().toLowerCase() === "openai") {
    const legacyOpenAIRequestURL = legacyChatUrl.trim().replace(/\/+$/, "");
    if (legacyOpenAIRequestURL) return legacyOpenAIRequestURL;
  }
  const base = trimmedBaseURL(baseUrl);
  if (!base) return "";
  switch (kind.trim().toLowerCase()) {
    case "anthropic":
      return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    case "responses":
    case "dashscope-responses":
      return `${base}/responses`;
    default:
      return `${base}/chat/completions`;
  }
}

export function providerBaseURLFromRequestURL(kind: string, requestUrl: string): string {
  const exactRequestURL = requestUrl.trim();
  if (!exactRequestURL) return "";
  const normalizedKind = kind.trim().toLowerCase();
  const suffixes = normalizedKind === "anthropic"
    ? ["/v1/messages"]
    : normalizedKind === "responses" || normalizedKind === "dashscope-responses"
      ? ["/responses"]
      : ["/chat/completions"];
  try {
    const parsed = new URL(exactRequestURL);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const suffix = suffixes.find((candidate) => pathname.endsWith(candidate));
    parsed.pathname = suffix ? pathname.slice(0, -suffix.length) || "/" : pathname || "/";
    parsed.search = "";
    parsed.hash = "";
    return trimmedBaseURL(parsed.toString());
  } catch {
    const suffix = suffixes.find((candidate) => exactRequestURL.endsWith(candidate));
    if (suffix) return trimmedBaseURL(exactRequestURL.slice(0, -suffix.length));
  }
  return trimmedBaseURL(exactRequestURL);
}

export function providerBaseURLForSave(
  initial: ProviderEndpointConfig | undefined,
  effectiveKind: string,
  effectiveRequestUrl: string,
): string {
  const requestUrl = effectiveRequestUrl.trim();
  if (initial) {
    const initialRequestUrl = providerRequestURLFromConfig(
      initial.kind,
      initial.baseUrl,
      initial.requestUrl ?? "",
      initial.chatUrl ?? "",
    );
    const kindUnchanged = initial.kind.trim().toLowerCase() === effectiveKind.trim().toLowerCase();
    if (kindUnchanged && initialRequestUrl === requestUrl) {
      return initial.baseUrl.trim();
    }
  }
  return providerBaseURLFromRequestURL(effectiveKind, requestUrl);
}

// Only rewrite a standard API suffix on an explicit protocol selection. Custom
// paths, queries and fragments are user-owned and must stay byte-for-byte intact.
export function providerRequestURLForFormatChange(previousKind: string, nextKind: string, requestUrl: string): string {
  if (previousKind === nextKind || !requestUrl) return requestUrl;
  try {
    const url = new URL(requestUrl);
    if (url.search || url.hash) return requestUrl;
    const previousSuffix = previousKind === "anthropic" ? "/messages"
      : previousKind === "responses" ? "/responses" : previousKind === "openai" ? "/chat/completions" : "";
    if (!previousSuffix || !url.pathname.endsWith(previousSuffix)) return requestUrl;
    const nextSuffix = nextKind === "anthropic" ? "/messages"
      : nextKind === "responses" ? "/responses" : nextKind === "openai" ? "/chat/completions" : "";
    if (!nextSuffix) return requestUrl;
    url.pathname = url.pathname.slice(0, -previousSuffix.length) + nextSuffix;
    return url.toString();
  } catch { return requestUrl; }
}

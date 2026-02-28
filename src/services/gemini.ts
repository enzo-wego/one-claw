import { config } from "../config.js";

export interface GeminiResult {
  text: string;
  sources: { title: string; url: string }[];
}

const MAX_RETRIES = 2;
const TIMEOUT_MS = 60_000;

export async function queryGemini(
  prompt: string,
  model: string
): Promise<GeminiResult | null> {
  if (!config.geminiApiKey) {
    console.error("[Gemini] GEMINI_API_KEY not configured");
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
  };
  const body = JSON.stringify(payload);

  console.log(`[Gemini] Request: model=${model}, prompt=${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(`[Gemini] ${res.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        console.error(`[Gemini] ${res.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Gemini] API error ${res.status}: ${errText}`);
        return null;
      }

      const data = await res.json();
      const result = parseResponse(data);
      console.log(`[Gemini] Response: ${result.text.slice(0, 200)}${result.text.length > 200 ? "..." : ""} (${result.sources.length} sources)`);
      return result;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[Gemini] Error — retrying in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error(`[Gemini] Failed after ${MAX_RETRIES} retries:`, err);
      return null;
    }
  }

  return null;
}

function parseResponse(data: any): GeminiResult {
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((p: any) => p.text || "")
    .join("") || "No response from Gemini.";

  const sources: { title: string; url: string }[] = [];
  const chunks = candidate?.groundingMetadata?.groundingChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      const web = chunk.web;
      if (web?.uri) {
        sources.push({ title: web.title || web.uri, url: web.uri });
      }
    }
  }

  return { text, sources };
}

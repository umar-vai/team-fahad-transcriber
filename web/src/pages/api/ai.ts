import type { APIRoute } from "astro";
import { aiText } from "../../lib/gemini";
import { handler, HttpError, json, requireUser } from "../../lib/http";

const MAX_CHARS = 120_000;
const TARGETS = ["Bangla", "English", "Arabic", "Hindi"];

function prompt(task: string, transcript: string, target: string, hasTimestamps: boolean): string {
  const text = `\n\nTRANSCRIPT:\n${transcript}`;
  switch (task) {
    case "summary":
      return `Summarize the following transcript for a client. Keep the summary accurate and useful.
Use the same main language as the transcript. Include:
1) a short executive summary,
2) 5-10 key points,
3) action items or decisions only if they are actually present.
Do not invent facts.${text}`;
    case "explain":
      return `Explain the transcript below clearly and accurately. Use the same main language as the transcript.
Structure the answer so it is easy to understand:
- What is being discussed
- Important context or meaning
- Key points in simple language
- Any terms or ideas that may need clarification
Do not invent facts or add claims that are not supported by the transcript.${text}`;
    case "translate":
      return `Translate the transcript below into ${target}. Preserve meaning, names, numbers, and paragraph structure.
If timestamp/speaker labels are present, preserve them. Do not summarize.${text}`;
    case "content":
      return `Turn this transcript into a practical creator/client content pack. Use the transcript's main language unless English is clearly better for a field.
${hasTimestamps ? "The transcript includes timestamps, so create accurate YouTube chapter suggestions from them." : "The transcript has no reliable timestamps, so do not invent chapter times."}
Return these sections:
- 10 strong title ideas
- Short description
- Full SEO-friendly description
- Key takeaways
- 5 short hooks for reels/shorts
- Suggested social caption
- Relevant tags/keywords/hashtags
- YouTube chapters only when reliable timestamps are present
- One clear CTA
Do not invent claims that are not in the transcript.${text}`;
    default:
      throw new HttpError(400, "Unknown AI tool.");
  }
}

export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const transcript = String(body.transcript || "").trim().slice(0, MAX_CHARS);
  if (!transcript) throw new HttpError(400, "There is no transcript yet.");
  const target = TARGETS.includes(body.target) ? body.target : "English";
  const text = await aiText(prompt(String(body.task), transcript, target, Boolean(body.hasTimestamps)));
  return json({ text });
});

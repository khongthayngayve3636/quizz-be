import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";
import { type QuizQuestion } from "../sampleQuiz.js";
import { type QuizPack } from "../types.js";
import { cleanText } from "../utils/helpers.js";
import { normalizeGeneratedQuestion } from "../utils/quizValidation.js";

export function normalizeQuizRequest(body: unknown) {
  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const topic = cleanText(source.topic, "Travel").slice(0, 200);
  const difficulty = cleanText(source.difficulty, "Easy").slice(0, 20);
  const additionalPrompt = cleanText(source.additionalPrompt, "").slice(0, 500);
  const count = Math.min(Math.max(Number(source.questions) || 5, 3), 15);
  const rawTypes = Array.isArray(source.types) ? source.types : ["mcq", "unscramble"];
  const types = rawTypes
    .map((type) => String(type))
    .filter((type): type is QuizQuestion["type"] => type === "mcq" || type === "unscramble");
  const includeImages = source.includeImages === true;

  return {
    topic,
    difficulty,
    additionalPrompt,
    questions: count,
    types: types.length ? types : (["mcq", "unscramble"] as QuizQuestion["type"][]),
    includeImages
  };
}

export function extractJson(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.substring(start, end + 1);
  }
  
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    return text.substring(arrayStart, arrayEnd + 1);
  }

  throw new Error("Gemini did not return valid JSON.");
}

export function normalizeGeneratedQuiz(raw: unknown, request: ReturnType<typeof normalizeQuizRequest>): QuizPack {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawQuestions = Array.isArray(source.questions) ? source.questions : Array.isArray(raw) ? raw : [];
  const questions = rawQuestions.map(normalizeGeneratedQuestion).filter((question): question is QuizQuestion => Boolean(question));

  const questionsWithImages = questions.map(q => {
    if (q.imageKeyword) {
      return {
        ...q,
        imageUrl: `https://image.pollinations.ai/prompt/${encodeURIComponent(q.imageKeyword)}?width=800&height=400&nologo=true`
      };
    }
    return q;
  });

  if (questionsWithImages.length < 1) {
    throw new Error("Gemini returned no usable quiz questions.");
  }

  return {
    title: cleanText(source.title, `${request.topic} ${request.difficulty}`),
    topic: request.topic,
    difficulty: request.difficulty,
    questions: questionsWithImages.slice(0, request.questions)
  };
}

export function getGeminiOutputText(data: Record<string, unknown>) {
  const directText = cleanText(data.output_text ?? data.outputText, "");
  if (directText) {
    return directText;
  }

  const steps = Array.isArray(data.steps) ? data.steps : [];
  const textBlocks = steps.flatMap((step) => {
    if (typeof step !== "object" || step === null) {
      return [];
    }

    const content = (step as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return [];
    }

    return content
      .map((item) => {
        if (typeof item !== "object" || item === null) {
          return "";
        }

        return cleanText((item as Record<string, unknown>).text, "");
      })
      .filter(Boolean);
  });

  return textBlocks.join("\n").trim();
}

export async function generateQuizWithGemini(request: ReturnType<typeof normalizeQuizRequest>) {
  let imageInstructions = "";
  if (request.includeImages) {
    imageInstructions = "For ALL questions, generate a descriptive 'imageKeyword' field containing a highly detailed text-to-image prompt (e.g. 'a majestic lion in a dense green jungle, photorealistic').";
  } else if (request.types.includes("unscramble")) {
    imageInstructions = "For ONLY 'unscramble' type questions, generate a descriptive 'imageKeyword' field containing a highly detailed text-to-image prompt. Do NOT generate 'imageKeyword' for 'mcq' questions.";
  }

  const jsonShape = request.includeImages || request.types.includes("unscramble") 
    ? "{\"title\":\"string\",\"questions\":[{\"type\":\"mcq\",\"question\":\"string\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":\"string\",\"imageKeyword\":\"string (optional)\"},{\"type\":\"unscramble\",\"question\":\"scrambled letters\",\"answer\":\"word\",\"imageKeyword\":\"string (optional)\"}]}"
    : "{\"title\":\"string\",\"questions\":[{\"type\":\"mcq\",\"question\":\"string\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":\"string\"},{\"type\":\"unscramble\",\"question\":\"scrambled letters\",\"answer\":\"word\"}]}";

  const prompt = [
    `Generate ${request.questions} English OPIC practice quiz questions.`,
    `Topic: ${request.topic}`,
    `Difficulty: ${request.difficulty}`,
    request.additionalPrompt ? `Additional Instructions: ${request.additionalPrompt}` : "",
    `Allowed types: ${request.types.join(", ")}`,
    imageInstructions,
    "Return JSON only with this shape:",
    jsonShape,
    "Rules: MCQ answer must exactly match one option. Unscramble question must be scrambled lowercase letters only. Keep questions short and classroom friendly."
  ].filter(Boolean).join("\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY ?? ""
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: "You create valid JSON quiz packs for a realtime English learning game. Think step-by-step before outputting the final JSON. Make sure to output valid JSON starting with { and ending with }.",
      input: prompt,
      generation_config: {
        temperature: 0.8
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${details.slice(0, 180)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const outputText = getGeminiOutputText(data);
  if (!outputText) {
    throw new Error("Gemini returned an empty response.");
  }

  const parsed = JSON.parse(extractJson(outputText)) as unknown;
  return normalizeGeneratedQuiz(parsed, request);
}

const pdfParse = require("pdf-parse");

/**
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @param {string} filename
 */
async function extractTextFromFile(buffer, mimetype, filename) {
  const lower = String(filename || "").toLowerCase();
  if (mimetype === "application/pdf" || lower.endsWith(".pdf")) {
    const data = await pdfParse(buffer);
    return String(data.text || "").trim();
  }
  if (
    mimetype === "text/plain" ||
    mimetype === "text/markdown" ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md")
  ) {
    return buffer.toString("utf8").trim();
  }
  throw new Error("Unsupported type. Upload a PDF, TXT, or MD file.");
}

/**
 * Rule-based questions when OpenAI is not configured or fails.
 * @param {string} text
 */
function generateRuleBasedQuestions(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 12000);
  const out = [];

  if (/fee|tuition|payment|installment/.test(t)) {
    out.push("What fees or payment schedule does this document mention?");
  }
  if (/scholar|financial aid|waiver/.test(t)) {
    out.push("What scholarships or financial aid are described?");
  }
  if (/deadline|last date|closing|due date/.test(t)) {
    out.push("What are the important deadlines I should remember?");
  }
  if (/entrance|exam|jee|sat|cut-?off|eligib/.test(t)) {
    out.push("What entrance tests or eligibility criteria are required?");
  }
  if (/document|certificate|marksheet|transfer/.test(t)) {
    out.push("Which documents do I need to submit for admission?");
  }
  if (/counsel|slot|interview|visit/.test(t)) {
    out.push("How do counseling or admission slots work according to this?");
  }
  if (/hostel|accommodation|residential/.test(t)) {
    out.push("Does this mention hostel or accommodation details?");
  }
  if (/refund|withdraw|cancel/.test(t)) {
    out.push("What is the policy for fee refund or withdrawal?");
  }

  if (out.length < 4) {
    out.push("What is the main admission process described in this file?");
    out.push("Are there program-specific notes I should know?");
    out.push("What should I prepare before the admission date?");
  }

  return [...new Set(out)].slice(0, 10);
}

/**
 * @param {string} text
 * @param {import("openai").default | null} openai
 */
async function generateQuestionsWithAi(text, openai) {
  if (!openai) return null;
  const excerpt = String(text || "").slice(0, 14000);
  if (excerpt.length < 50) return null;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You help students applying to university. From the document text, output a JSON object with key 'questions' containing 5 to 10 short, specific questions a student might ask based ONLY on that content. No hallucinations: if something is not in the text, do not invent it—ask what the document says about that topic instead. Return only valid JSON.",
        },
        { role: "user", content: excerpt },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.questions) ? parsed.questions : parsed.q;
    if (Array.isArray(list) && list.length) {
      return list.map((q) => String(q).trim()).filter(Boolean).slice(0, 10);
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  extractTextFromFile,
  generateRuleBasedQuestions,
  generateQuestionsWithAi,
};

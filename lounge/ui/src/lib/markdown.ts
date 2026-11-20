import DOMPurify from "dompurify";
import { Marked } from "marked";

const md = new Marked({ gfm: true, breaks: true, async: false });

// Raw HTML in a message shows as text.
md.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// The sanitizer drops input, so a task box becomes text.
const CHECKBOX = /<input\b[^>]*type="checkbox"[^>]*>/g;

// Markdown to HTML, before the sanitizer.
export function markdownHtml(text: string): string {
  const html = md.parse(text) as string;
  return html.replace(CHECKBOX, (tag) => (/\bchecked\b/.test(tag) ? "☑" : "☐"));
}

let hooked = false;

// Safe HTML for {@html}. Browser only.
export function renderMarkdown(text: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  return DOMPurify.sanitize(markdownHtml(text), {
    // Embeds show media; no remote loads from text.
    FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "video", "audio"],
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

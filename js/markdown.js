import { esc } from "./util.js";

export function renderMarkdown(markdown, resolveUrl = (url) => url) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let index = 0;
  const paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join("\n");
    paragraph.length = 0;
    html += `<p>${inline(text, resolveUrl)}</p>`;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("```")) {
      flushParagraph();
      const buffer = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        buffer.push(lines[index]);
        index += 1;
      }
      html += `<pre><code>${esc(buffer.join("\n"))}</code></pre>`;
      if (index < lines.length) index += 1;
      continue;
    }

    const heading = /^(#{1,3}) /.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html += `<h${level}>${inline(line.slice(level + 1), resolveUrl)}</h${level}>`;
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph();
      html += "<hr>";
      index += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      const buffer = [];
      while (index < lines.length && lines[index].startsWith("> ")) {
        buffer.push(lines[index].slice(2));
        index += 1;
      }
      html += `<blockquote><p>${inline(buffer.join("\n"), resolveUrl)}</p></blockquote>`;
      continue;
    }

    if (/^[-*] /.test(line)) {
      flushParagraph();
      const items = [];
      while (index < lines.length && /^[-*] /.test(lines[index])) {
        items.push(`<li>${inline(lines[index].slice(2), resolveUrl)}</li>`);
        index += 1;
      }
      html += `<ul>${items.join("")}</ul>`;
      continue;
    }

    if (/^\d+\. /.test(line)) {
      flushParagraph();
      const items = [];
      while (index < lines.length && /^\d+\. /.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\d+\. /, ""), resolveUrl)}</li>`);
        index += 1;
      }
      html += `<ol>${items.join("")}</ol>`;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return html;
}

function inline(raw, resolveUrl) {
  const pattern = /(`[^`]+`)|(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let html = "";
  let last = 0;
  for (const match of raw.matchAll(pattern)) {
    if (match.index > last) html += esc(raw.slice(last, match.index));
    if (match[1]) {
      html += `<code>${esc(match[1].slice(1, -1))}</code>`;
    } else if (match[2]) {
      const src = safeUrl(match[4], resolveUrl);
      html += src
        ? `<img src="${esc(src)}" alt="${esc(match[3])}" referrerpolicy="no-referrer">`
        : esc(match[3]);
    } else if (match[5]) {
      const href = safeHttpsUrl(match[7]);
      html += href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(match[6])}</a>`
        : esc(match[6]);
    } else if (match[8]) {
      html += `<strong>${esc(match[9])}</strong>`;
    } else if (match[10]) {
      html += `<em>${esc(match[11])}</em>`;
    }
    last = match.index + match[0].length;
  }
  if (last < raw.length) html += esc(raw.slice(last));
  return html.replace(/\n/g, "<br>");
}

function safeUrl(url, resolveUrl) {
  const trimmed = String(url || "").trim();
  if (!trimmed.startsWith("images/") || trimmed.includes("..") || trimmed.includes("\\")) return "";
  const resolved = String(resolveUrl(trimmed) || "");
  if (/^blob:/i.test(resolved) || /^https:\/\//i.test(resolved) || resolved.startsWith("/") || resolved.startsWith("content/")) {
    return resolved;
  }
  return "";
}

function safeHttpsUrl(url) {
  const trimmed = String(url || "").trim();
  if (!/^https:\/\/[^\s<>"\\]+$/i.test(trimmed)) return "";
  return trimmed;
}

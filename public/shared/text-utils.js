export function textHash(text) {
  let hash = 0;
  for (let index = 0; index < String(text || "").length; index += 1) {
    hash = ((hash << 5) - hash + String(text).charCodeAt(index)) | 0;
  }
  return String(hash);
}

export function linkify(text) {
  return text.replace(/https?:\/\/[^\s<]+/g, (match) => {
    let url = match;
    let trailing = "";
    while (/[),.;!?，。！？；：）】》'"’”]$/.test(url)) {
      if (url.endsWith(")") && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>${trailing}`;
  });
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value);
}

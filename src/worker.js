export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      if (pathname === "/" && request.method === "GET") {
        return htmlResponse(renderLandingPage());
      }

      if (pathname.endsWith("/") && isUuidPath(pathname.slice(0, -1))) {
        return new Response(null, {
          status: 301,
          headers: { location: pathname.slice(0, -1) },
        });
      }

      if (isUuidPath(pathname) && request.method === "GET") {
        const userId = pathname.slice(1);
        await ensureUser(env, userId);
        return htmlResponse(renderHomePage(userId), {
          "set-cookie": `user_id=${userId}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }

      if (pathname === "/app.js" && request.method === "GET") {
        return jsResponse(appJs());
      }

      if (pathname === "/styles.css" && request.method === "GET") {
        return cssResponse(stylesCss());
      }

      if (pathname.startsWith("/api/")) {
        const userId = getOrCreateUserId(request);
        if (!userId) {
          return jsonResponse({ error: "Unable to determine user id." }, 400);
        }
        return await handleApi(request, env, userId, url);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return jsonResponse({ error: "Server error", detail: String(err) }, 500);
    }
  },
};

function htmlResponse(body, headers = {}) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...headers,
    },
  });
}

function jsResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cssResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function getOrCreateUserId(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/user_id=([^;]+)/);
  if (match) return match[1];

  return null;
}

function isUuidPath(pathname) {
  if (!pathname || pathname.length !== 37) return false;
  const value = pathname.slice(1);
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
    value
  );
}

async function ensureUser(env, userId) {
  const key = userMetaKey(userId);
  const existing = await env.BOOKMARKS.get(key);
  if (existing) return;
  const meta = { id: userId, createdAt: new Date().toISOString() };
  await env.BOOKMARKS.put(key, JSON.stringify(meta));
}

function userMetaKey(userId) {
  return `user:${userId}:meta`;
}

async function handleApi(request, env, userId, url) {
  const { pathname, searchParams } = url;

  if (pathname === "/api/bookmarks" && request.method === "GET") {
    const tagsParam = searchParams.get("tags") || "";
    const q = (searchParams.get("q") || "").toLowerCase();
    const tags = tagsParam
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const bookmarks = await listBookmarks(env, userId);
    const filtered = bookmarks
      .filter((b) => {
      const tagsOk = tags.length === 0 || tags.every((t) => b.tags.includes(t));
      const qOk =
        q.length === 0 ||
        b.imageUrl.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q));
      return tagsOk && qOk;
    })
      .sort((a, b) => {
        const aTime = Date.parse(a.createdAt || a.updatedAt || 0);
        const bTime = Date.parse(b.createdAt || b.updatedAt || 0);
        return bTime - aTime;
      });

    return jsonResponse({ items: filtered });
  }

  if (pathname === "/api/bookmarks" && request.method === "POST") {
    const body = await request.json();
    const { imageUrl, tags = [] } = body || {};

    if (!imageUrl || typeof imageUrl !== "string") {
      return jsonResponse({ error: "imageUrl is required" }, 400);
    }

    const normalizedTags = normalizeTags(tags);
    const id = await bookmarkIdFromUrl(imageUrl);

    const bookmark = {
      id,
      imageUrl,
      tags: normalizedTags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await env.BOOKMARKS.put(bookmarkKey(userId, id), JSON.stringify(bookmark));

    return jsonResponse({ ok: true, item: bookmark });
  }

  if (pathname === "/api/bookmarks" && request.method === "DELETE") {
    const body = await request.json();
    const { imageUrl } = body || {};
    if (!imageUrl) {
      return jsonResponse({ error: "imageUrl is required" }, 400);
    }
    const id = await bookmarkIdFromUrl(imageUrl);
    await env.BOOKMARKS.delete(bookmarkKey(userId, id));
    return jsonResponse({ ok: true });
  }

  if (pathname === "/api/tags" && request.method === "PUT") {
    const body = await request.json();
    const { imageUrl, tags = [] } = body || {};

    if (!imageUrl) {
      return jsonResponse({ error: "imageUrl is required" }, 400);
    }

    const id = await bookmarkIdFromUrl(imageUrl);
    const key = bookmarkKey(userId, id);
    const existing = await env.BOOKMARKS.get(key);
    if (!existing) {
      return jsonResponse({ error: "bookmark not found" }, 404);
    }

    const bookmark = JSON.parse(existing);
    bookmark.tags = normalizeTags(tags);
    bookmark.updatedAt = new Date().toISOString();

    await env.BOOKMARKS.put(key, JSON.stringify(bookmark));
    return jsonResponse({ ok: true, item: bookmark });
  }

  return jsonResponse({ error: "Not Found" }, 404);
}

function bookmarkKey(userId, id) {
  return `user:${userId}:bookmark:${id}`;
}

async function bookmarkIdFromUrl(imageUrl) {
  const data = new TextEncoder().encode(imageUrl);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function listBookmarks(env, userId) {
  const prefix = `user:${userId}:bookmark:`;
  let cursor = undefined;
  const items = [];

  do {
    const resp = await env.BOOKMARKS.list({ prefix, cursor, limit: 1000 });
    cursor = resp.cursor;
    const values = await Promise.all(
      resp.keys.map((k) => env.BOOKMARKS.get(k.name))
    );
    for (const value of values) {
      if (value) items.push(JSON.parse(value));
    }
  } while (cursor);

  return items;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const normalized = tags
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  return Array.from(new Set(normalized));
}

function renderHomePage(userId) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Image Bookmark</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body data-user-id="${userId}">
  <header class="hero">
    <div class="hero-inner">
      <div>
        <h1>Image Bookmark</h1>
        <p>Save, tag, and find images fast.</p>
      </div>
      <div class="search-panel">
        <input id="search" type="search" placeholder="Search by tag or URL" />
        <input id="tagFilter" type="text" placeholder="Filter tags (comma separated)" />
        <button id="refresh">Search</button>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="add-form">
      <h2>Add or Update Bookmark</h2>
      <div class="form-row">
        <input id="imageUrl" type="url" placeholder="Image URL (.jpg, .png, .gif, ...)" required />
        <input id="tags" type="text" placeholder="Tags (comma separated)" />
        <button id="save">Save</button>
      </div>
    </section>

    <section>
      <div id="grid" class="grid"></div>
    </section>
  </main>

  <dialog id="previewDialog" class="dialog">
    <div class="dialog-body">
      <img id="previewImage" alt="Preview" />
      <div class="dialog-meta">
        <div id="previewTags" class="tags"></div>
        <div class="dialog-actions">
          <button id="copyUrl">Copy Image URL</button>
          <button id="editTags">Edit Tags</button>
          <button id="deleteBookmark" class="danger">Delete</button>
          <button id="closePreview" class="ghost">Close</button>
        </div>
      </div>
    </div>
  </dialog>

  <dialog id="editDialog" class="dialog">
    <div class="dialog-body">
      <h3>Edit Tags</h3>
      <input id="editTagsInput" type="text" placeholder="Tags (comma separated)" />
      <div class="dialog-actions">
        <button id="saveTags">Save</button>
        <button id="cancelEdit" class="ghost">Cancel</button>
      </div>
    </div>
  </dialog>

  <dialog id="confirmDialog" class="dialog">
    <div class="dialog-body">
      <h3>Delete Bookmark?</h3>
      <p>This cannot be undone.</p>
      <div class="dialog-actions">
        <button id="confirmDelete" class="danger">Delete</button>
        <button id="cancelDelete" class="ghost">Cancel</button>
      </div>
    </div>
  </dialog>

  <script src="/app.js"></script>
</body>
</html>`;
}

function renderLandingPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Image Bookmark</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <div>
        <h1>Image Bookmark</h1>
        <p>Open with a user UUID, for example:</p>
        <p><code>https://domain.com/&lt;uuid&gt;</code></p>
      </div>
    </div>
  </header>
</body>
</html>`;
}
function stylesCss() {
  return `:root {
  --bg: #f5f0ea;
  --card: #fff6ee;
  --ink: #1d1b18;
  --accent: #d45b2c;
  --accent-2: #2a7f62;
  --muted: #7b6f64;
  --border: #e2d4c5;
  --shadow: rgba(36, 23, 12, 0.08);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Space Grotesk", "Gill Sans", "Trebuchet MS", sans-serif;
  color: var(--ink);
  background: radial-gradient(circle at top, #fff0e1 0%, #f5f0ea 55%, #efe4da 100%);
}

.hero {
  padding: 48px 24px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(120deg, #f5a36f 0%, #f7c59f 42%, #f2e1cf 100%);
}

.hero-inner {
  width: 100%;
  max-width: none;
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  align-items: center;
  padding: 0 24px;
}

.hero h1 {
  font-size: 40px;
  margin: 0 0 8px;
}

.hero p {
  margin: 0;
  color: var(--muted);
}

.search-panel {
  display: grid;
  gap: 12px;
}

.search-panel input,
.form-row input {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: #fffaf4;
  font-size: 14px;
}

.search-panel button,
.form-row button {
  padding: 12px 16px;
  border-radius: 10px;
  border: none;
  background: var(--accent);
  color: white;
  font-weight: 600;
  cursor: pointer;
}

.container {
  max-width: none;
  margin: 0;
  padding: 24px;
}

.add-form {
  margin-bottom: 24px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px;
  box-shadow: 0 10px 20px var(--shadow);
}

.form-row {
  display: grid;
  grid-template-columns: 2fr 2fr 1fr;
  gap: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  width: 100%;
}

.card {
  border-radius: 14px;
  overflow: hidden;
  background: white;
  border: 1px solid var(--border);
  box-shadow: 0 8px 16px var(--shadow);
  display: flex;
  flex-direction: column;
}

.card img {
  width: 100%;
  height: 400px;
  object-fit: contain;
  display: block;
}

.card-body {
  padding: 10px 12px 12px;
  display: grid;
  gap: 8px;
  font-size: 13px;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--accent-2);
  color: white;
  font-size: 12px;
}

.card-actions {
  display: flex;
  gap: 8px;
}

.card-actions button {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff3ea;
  cursor: pointer;
  font-size: 12px;
}

@media (max-width: 900px) {
  .hero-inner {
    grid-template-columns: 1fr;
  }
  .form-row {
    grid-template-columns: 1fr;
  }
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.dialog {
  border: none;
  border-radius: 16px;
  padding: 0;
  max-width: 900px;
  width: min(92vw, 900px);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
}

.dialog::backdrop {
  background: rgba(20, 16, 12, 0.55);
  backdrop-filter: blur(3px);
}

.dialog-body {
  padding: 20px;
  display: grid;
  gap: 16px;
  max-height: 85vh;
  overflow: hidden;
}

.dialog-body img {
  width: 100%;
  height: auto;
  max-height: 65vh;
  object-fit: contain;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
}

.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.dialog-actions button {
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: #fff3ea;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.dialog-actions button.danger {
  background: #d2412f;
  border-color: #c0382a;
  color: white;
}

.dialog-actions button.ghost {
  background: transparent;
}

.dialog-meta {
  display: grid;
  gap: 12px;
}
`;
}

function appJs() {
  return `const $ = (id) => document.getElementById(id);
const previewDialog = $("previewDialog");
const editDialog = $("editDialog");
const confirmDialog = $("confirmDialog");
const previewImage = $("previewImage");
const previewTags = $("previewTags");
const editTagsInput = $("editTagsInput");
const copyUrlBtn = $("copyUrl");
const editTagsBtn = $("editTags");
const deleteBtn = $("deleteBookmark");
const closePreviewBtn = $("closePreview");
const saveTagsBtn = $("saveTags");
const cancelEditBtn = $("cancelEdit");
const confirmDeleteBtn = $("confirmDelete");
const cancelDeleteBtn = $("cancelDelete");
let activeBookmark = null;
let bookmarksState = [];

function parseTags(value) {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function setActiveBookmark(bookmark) {
  activeBookmark = bookmark;
  if (!bookmark) return;
  previewImage.src = bookmark.imageUrl;
  previewTags.innerHTML = "";
  (bookmark.tags || []).forEach((t) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = t;
    previewTags.appendChild(tag);
  });
}

function openDialog(dialog) {
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog && dialog.open) dialog.close();
}

function wireBackdropClose(dialog) {
  if (!dialog) return;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function copyImageUrl() {
  if (!activeBookmark) return;
  const value = activeBookmark.imageUrl;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
  } else {
    const input = document.createElement("input");
    input.value = value;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
  }
}

async function loadBookmarks() {
  const q = $("search").value.trim();
  const tags = $("tagFilter").value.trim();
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tags) params.set("tags", tags);

  const resp = await fetch("/api/bookmarks?" + params.toString());
  const data = await resp.json();
  bookmarksState = sortBookmarks(data.items || []);
  renderGrid(bookmarksState);
}

function sortBookmarks(items) {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt || 0);
    const bTime = Date.parse(b.updatedAt || b.createdAt || 0);
    return bTime - aTime;
  });
}

function upsertBookmark(item) {
  const index = bookmarksState.findIndex((b) => b.id === item.id);
  if (index >= 0) {
    bookmarksState[index] = item;
  } else {
    bookmarksState.unshift(item);
  }
  bookmarksState = sortBookmarks(bookmarksState);
}

function removeBookmarkByUrl(imageUrl) {
  bookmarksState = bookmarksState.filter((b) => b.imageUrl !== imageUrl);
}

function renderGrid(items) {
  const grid = $("grid");
  grid.innerHTML = "";
  if (items.length === 0) {
    grid.innerHTML = "<p>No bookmarks yet.</p>";
    return;
  }

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<img src="' +
      item.imageUrl +
      '" alt="bookmark" loading="lazy" />' +
      '<div class="card-body">' +
      '<div class="tags">' +
      (item.tags || [])
        .map((t) => '<span class="tag">' + t + "</span>")
        .join("") +
      "</div>" +
      '<div class="card-actions">' +
      '<button data-action="edit">Edit Tags</button>' +
      '<button data-action="delete">Delete</button>' +
      "</div>" +
      "</div>";

    card.addEventListener("click", () => {
      setActiveBookmark(item);
      openDialog(previewDialog);
    });

    card.querySelector('[data-action="edit"]').addEventListener("click", (event) => {
      event.stopPropagation();
      setActiveBookmark(item);
      editTagsInput.value = (item.tags || []).join(", ");
      openDialog(editDialog);
    });

    card.querySelector('[data-action="delete"]').addEventListener("click", (event) => {
      event.stopPropagation();
      setActiveBookmark(item);
      openDialog(confirmDialog);
    });

    grid.appendChild(card);
  }
}

$("save").addEventListener("click", async () => {
  const imageUrl = $("imageUrl").value.trim();
  const tags = parseTags($("tags").value);
  if (!imageUrl) return alert("Image URL required");

  const resp = await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageUrl, tags }),
  });
  if (!resp.ok) {
    return alert("Failed to save bookmark");
  }
  const data = await resp.json();
  if (data.item) {
    upsertBookmark(data.item);
    renderGrid(bookmarksState);
  }

  $("imageUrl").value = "";
  $("tags").value = "";
});

$("refresh").addEventListener("click", loadBookmarks);

wireBackdropClose(previewDialog);
wireBackdropClose(editDialog);
wireBackdropClose(confirmDialog);

copyUrlBtn.addEventListener("click", async () => {
  await copyImageUrl();
});

editTagsBtn.addEventListener("click", () => {
  if (!activeBookmark) return;
  editTagsInput.value = (activeBookmark.tags || []).join(", ");
  openDialog(editDialog);
});

deleteBtn.addEventListener("click", () => {
  if (!activeBookmark) return;
  openDialog(confirmDialog);
});

closePreviewBtn.addEventListener("click", () => {
  closeDialog(previewDialog);
});

saveTagsBtn.addEventListener("click", async () => {
  if (!activeBookmark) return;
  const tags = parseTags(editTagsInput.value);
  const resp = await fetch("/api/tags", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageUrl: activeBookmark.imageUrl, tags }),
  });
  if (!resp.ok) {
    return alert("Failed to update tags");
  }
  const data = await resp.json();
  if (data.item) {
    upsertBookmark(data.item);
  }
  closeDialog(editDialog);
  renderGrid(bookmarksState);
});

cancelEditBtn.addEventListener("click", () => {
  closeDialog(editDialog);
});

confirmDeleteBtn.addEventListener("click", async () => {
  if (!activeBookmark) return;
  const imageUrl = activeBookmark.imageUrl;
  const resp = await fetch("/api/bookmarks", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageUrl }),
  });
  if (!resp.ok) {
    return alert("Failed to delete bookmark");
  }
  removeBookmarkByUrl(imageUrl);
  closeDialog(confirmDialog);
  closeDialog(previewDialog);
  renderGrid(bookmarksState);
});

cancelDeleteBtn.addEventListener("click", () => {
  closeDialog(confirmDialog);
});

window.addEventListener("load", async () => {
  await loadBookmarks();
});
`;
}

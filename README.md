# Image Bookmark (Cloudflare Workers + KV) by Codex

A lightweight image bookmarking app built on Cloudflare Workers. Each user is scoped by UUID and enters via `https://your-domain.com/<uuid>`. Bookmarks and tags are stored in Workers KV.

## Features

- Add, update, delete image bookmarks (one bookmark per image URL)
- Tag management per bookmark
- Filter by tags and search by URL/tag
- Responsive grid layout (6 columns desktop, 2 columns mobile)
- Image preview dialog with edit/delete/copy URL
- Per-user data isolation via UUID

## Architecture

- Worker serves the UI (`/`, `/app.js`, `/styles.css`)
- UUID entry point: `/<uuid>` sets `user_id` cookie and creates user meta
- API routes under `/api/*` use KV for storage

## Endpoints

- `GET /<uuid>`: entry point, sets cookie, creates user if missing
- `GET /api/bookmarks?tags=a,b&q=term`: list/filter bookmarks
- `POST /api/bookmarks`: add/update bookmark
  - Body: `{ "imageUrl": "...", "tags": ["tag1", "tag2"] }`
- `DELETE /api/bookmarks`: delete bookmark
  - Body: `{ "imageUrl": "..." }`
- `PUT /api/tags`: update tags for a bookmark
  - Body: `{ "imageUrl": "...", "tags": ["tag1"] }`

## Setup

1. Create a KV namespace in Cloudflare.
2. Update `wrangler.toml` with your KV namespace ID.
3. Deploy:

```bash
wrangler deploy
```

## Local Dev

```bash
wrangler dev
```

## Notes

- Image bookmarks are keyed by SHA-256 of the image URL.
- UUIDs are validated to standard RFC 4122 formats.

## License

MIT

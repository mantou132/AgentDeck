---
name: map
description: Show places and routes on a map in the AgentDeck client. Use whenever the answer involves locations, addresses, points of interest, trips, routes or tracks that are easier to grasp on a map; answer with an `agentdeck-map` fenced block holding markers and routes, instead of map links, image files, HTML files or other map tools.
---

# AgentDeck maps

The AgentDeck client renders a fenced code block with the `agentdeck-map` language as a map card, in place, inside your reply. Tapping the card opens a full-screen map where markers show their name and description.

````markdown
```agentdeck-map
{
  "title": "Bund walk",
  "markers": [
    { "name": "Nanjing Rd", "description": "Start here", "coordinates": [121.4800, 31.2390] },
    { "name": "Yu Garden", "coordinates": [121.4920, 31.2272] }
  ],
  "routes": [
    { "name": "Walk", "coordinates": [[121.4800, 31.2390], [121.4905, 31.2405], [121.4920, 31.2272]] }
  ]
}
```
````

## Format

- The body is one strict JSON object: no comments, trailing commas or JavaScript.
- Every coordinate is `[longitude, latitude]` in WGS 84 (GeoJSON order: longitude first). Do not use GCJ-02 or BD-09 offsets.
- `markers` (optional): points with `coordinates`, a short `name` shown as the label and an optional `description` shown when tapped.
- `routes` (optional): lines with at least two `coordinates`, drawn in order, and an optional `name`.
- `title` (optional): shown on the card; otherwise the first marker's name is used.
- At least one marker or route is required. The map fits all of them automatically, so do not specify center or zoom.

## Rules

- Only use coordinates you know or looked up; never invent places. Keep routes to what the map needs (at most a few hundred points); simplify long tracks.
- Write the block directly in your reply; do not create files or call tools to draw the map.
- Do not repeat every coordinate as a list or table; add at most a sentence or two of context.
